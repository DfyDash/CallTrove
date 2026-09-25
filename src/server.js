require("dotenv").config();
const path = require("path");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");

const apiRouter = require("./routes/api");
const authRouter = require("./routes/auth");
const adminRouter = require("./routes/admin");
const operatorRouter = require("./routes/operator");
const { requireAuth } = require("./auth");
const poller = require("./poller");
const transcriptionPoller = require("./transcriptionPoller");

const app = express();

app.set("trust proxy", 1); // behind nginx, which terminates TLS

// Everything served here is self-hosted (no CDNs, no third-party scripts/
// styles/fonts anywhere in the app), so the CSP can stay tight instead of
// needing 'unsafe-inline' or a growing allowlist. The one exception is
// mediaSrc: recording playback redirects to a presigned S3 URL when
// STORAGE_DRIVER=s3 (a different origin than the app itself), so that
// origin has to be allowed explicitly or the browser silently refuses to
// load the audio -- the <audio> element renders, but nothing plays.
const mediaSrc = ["'self'"];
if (process.env.STORAGE_DRIVER === "s3" && process.env.S3_BUCKET) {
  mediaSrc.push(`https://${process.env.S3_BUCKET}.s3.${process.env.S3_REGION || "us-east-1"}.amazonaws.com`);
}

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'"],
        connectSrc: ["'self'"],
        mediaSrc,
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    // Off: the same cross-origin S3 redirect mediaSrc allows above would
    // still get blocked by COEP's default "require-corp", which needs a
    // matching Cross-Origin-Resource-Policy header back from S3 that it
    // doesn't send by default. Not worth the breakage for an app with no
    // need for the cross-origin isolation COEP exists to provide.
    crossOriginEmbedderPolicy: false,
  })
);

app.get("/health", (req, res) => res.json({ ok: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: true, sameSite: "lax", maxAge: 12 * 60 * 60 * 1000 },
  })
);

// Unauthenticated: the marketing homepage, privacy policy, and terms --
// reachable whether or not there's a session, since a logged-out visitor
// hitting "/" needs something other than a bounce to /login.html. Placed
// ahead of requireAuth so a logged-in session isn't blocked from these
// either; "/" specifically falls through to the real dashboard (served by
// the static middleware's default-index behavior after requireAuth) once
// a session exists, rather than always showing the marketing page.
app.get("/", (req, res, next) => {
  if (req.session.user) return next();
  res.sendFile(path.join(__dirname, "..", "public", "home.html"));
});
app.get("/privacy.html", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "privacy.html")));
app.get("/terms.html", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "terms.html")));
app.get("/marketing.css", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "marketing.css")));

// Unauthenticated: the login page itself and what it needs to render.
app.get("/login.html", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "login.html")));
app.get("/login.js", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "login.js")));
// Reachable pre-login same as login.html itself -- this is the second step
// of logging in (password already checked, waiting on the TOTP code), so
// req.session.user isn't set yet and requireAuth (mounted below) would
// otherwise bounce it back to /login.html.
app.get("/login-mfa.html", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "login-mfa.html")));
app.get("/login-mfa.js", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "login-mfa.js")));
app.get("/login-mfa-email.html", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "login-mfa-email.html")));
app.get("/login-mfa-email.js", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "login-mfa-email.js")));
// Not linked from anywhere public yet -- reachable only by direct URL
// while self-serve signup is still being tested (see routes/auth.js's
// /signup and the user-facing note this was scoped down to).
app.get("/signup.html", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "signup.html")));
app.get("/signup.js", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "signup.js")));
app.get("/style.css", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "style.css")));
app.get("/theme.js", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "theme.js")));
app.get("/favicon.svg", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "favicon.svg")));
app.get("/favicon-32.png", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "favicon-32.png")));
app.get("/apple-touch-icon.png", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "apple-touch-icon.png")));
// Browsers request this by default even without a <link rel="icon">
// pointing at it -- served from the same 32px PNG rather than a real
// .ico file, which every modern browser accepts fine.
app.get("/favicon.ico", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "favicon-32.png")));
app.use("/fonts", express.static(path.join(__dirname, "..", "public", "fonts")));
app.use("/auth", authRouter);

app.use(requireAuth);
app.use(express.json());
app.use("/api/admin", adminRouter);
app.use("/api/operator", operatorRouter);
app.use("/api", apiRouter);
app.use(express.static(path.join(__dirname, "..", "public")));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`CallTrove listening on port ${port}`);
});

// Call ingestion now happens by polling GHL's own API rather than a GHL
// workflow/webhook -- see src/poller.js for why.
poller.start();
transcriptionPoller.start();
// Account purge is deliberately NOT run automatically here -- see
// src/tenantPurge.js. It's a manual operator command
// (`node src/tenantPurge.js --list` / `--purge <tenantId>`) run by hand
// against one specific tenant at a time, so a bug in the
// "ready for purge" query can never delete real customer data on its own.
