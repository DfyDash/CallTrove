// A paying customer who hasn't connected GoHighLevel yet has nothing to
// show on the dashboard or contacts pages, and the data requests would be
// refused. Check first, and show what to do next instead.
function hasNoAccounts(me) {
  return !!me && Array.isArray(me.accounts) && me.accounts.length === 0 && !me.currentAccountId;
}

function showConnectPrompt(me) {
  const main = document.querySelector("main.content");
  if (!main) return;
  const keep = new Set([main.querySelector(".content-header"), document.getElementById("cancellation-banner")]);
  Array.from(main.children).forEach((el) => {
    if (!keep.has(el)) el.remove();
  });
  document.body.classList.add("no-accounts");
  const searchWrap = document.querySelector(".search-wrap");
  if (searchWrap) searchWrap.hidden = true;

  const card = document.createElement("div");
  card.className = "connect-prompt";
  const title = document.createElement("h1");
  title.textContent = "Connect your GoHighLevel account";
  const body = document.createElement("p");
  const isAdmin = me.role === "admin";
  body.textContent = isAdmin
    ? "Your subscription is active. Connect your GoHighLevel account and CallTrove will start saving your call recordings."
    : "Your account doesn't have a GoHighLevel account connected yet. Ask your account admin to connect it from Settings.";
  card.append(title, body);
  if (isAdmin) {
    const link = document.createElement("a");
    link.className = "button-link";
    link.href = "/settings.html#accounts";
    link.textContent = "Connect GoHighLevel";
    card.append(link);
  }
  main.append(card);
}
