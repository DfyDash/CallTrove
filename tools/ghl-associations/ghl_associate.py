#!/usr/bin/env python3
"""Create GoHighLevel contact <-> event associations from a spreadsheet.

Dry run by default; pass --apply to actually create relations.

Env vars:
  GHL_TOKEN        Private Integration token (scopes: associations.readonly,
                   associations/relation.write, objects/record.readonly)
  GHL_LOCATION_ID  Sub-account (location) id

Examples:
  python ghl_associate.py --list-associations
  python ghl_associate.py sheet.xlsx --association-id ABC123 \
      --event-object-key custom_objects.events --event-field event_id
  python ghl_associate.py sheet.xlsx ... --apply
"""
import argparse, csv, json, os, sys, time, urllib.error, urllib.parse, urllib.request

try:
    import openpyxl
except ImportError:
    sys.exit("Missing dependency: pip install openpyxl")

BASE = "https://services.leadconnectorhq.com"


def call(method, path, body=None, params=None, retries=5):
    url = BASE + path + ("?" + urllib.parse.urlencode(params) if params else "")
    data = json.dumps(body).encode() if body is not None else None
    for attempt in range(retries):
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": "Bearer " + os.environ["GHL_TOKEN"],
            "Version": "2021-07-28",
            "Content-Type": "application/json",
            "Accept": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            text = e.read().decode(errors="replace")
            if e.code in (429, 500, 502, 503) and attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            raise RuntimeError(f"{e.code} {text[:300]}")


def list_associations(loc):
    out, skip = [], 0
    while True:
        page = call("GET", "/associations/", params={"locationId": loc, "skip": skip, "limit": 100})
        items = page.get("associations", page if isinstance(page, list) else [])
        out += items
        if len(items) < 100:
            return out
        skip += 100


def find_event(obj_key, field, value, loc):
    res = call("POST", f"/objects/{obj_key}/records/search", {
        "locationId": loc, "page": 1, "pageLimit": 5,
        "query": f"{field}:{value}", "searchAfter": []})
    for rec in res.get("records", []):
        props = rec.get("properties") or {}
        if str(props.get(field, "")).strip() == value:
            return rec["id"]
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("xlsx", nargs="?")
    ap.add_argument("--list-associations", action="store_true")
    ap.add_argument("--association-id")
    ap.add_argument("--event-object-key", help="e.g. custom_objects.events")
    ap.add_argument("--event-field", default="event_id", help="event property that holds the EVT-... value")
    ap.add_argument("--contact-col", default="Contact Id")
    ap.add_argument("--event-col", default="Event ID")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--out", default="results.csv")
    a = ap.parse_args()

    loc = os.environ.get("GHL_LOCATION_ID")
    if not os.environ.get("GHL_TOKEN") or not loc:
        sys.exit("Set GHL_TOKEN and GHL_LOCATION_ID")

    if a.list_associations:
        for x in list_associations(loc):
            print(x.get("id"), x.get("key"), x.get("firstObjectKey"), "<->", x.get("secondObjectKey"))
        return
    if not (a.xlsx and a.association_id and a.event_object_key):
        ap.error("xlsx, --association-id and --event-object-key are required")

    assoc = call("GET", f"/associations/{a.association_id}", params={"locationId": loc})
    contact_first = str(assoc.get("firstObjectKey", "")).startswith("contact")
    print(f"Association {assoc.get('key')}: {assoc.get('firstObjectKey')} <-> {assoc.get('secondObjectKey')}")

    ws = openpyxl.load_workbook(a.xlsx, read_only=True).active
    rows = ws.iter_rows(values_only=True)
    header = [str(h).strip() if h else "" for h in next(rows)]
    ci, ei = header.index(a.contact_col), header.index(a.event_col)

    pairs, seen, results = [], set(), []
    for n, r in enumerate(rows, 2):
        cid = (str(r[ci]).strip() if r[ci] else "")
        evt = (str(r[ei]).strip() if r[ei] else "")
        if not cid or not evt:
            results.append((n, cid, evt, "skipped", "missing contact id or event id"))
        elif (cid, evt) in seen:
            results.append((n, cid, evt, "skipped", "duplicate row"))
        else:
            seen.add((cid, evt))
            pairs.append((n, cid, evt))

    event_cache = {}
    for evt in sorted({p[2] for p in pairs}):
        event_cache[evt] = find_event(a.event_object_key, a.event_field, evt, loc)
        print(f"  event {evt} -> {event_cache[evt] or 'NOT FOUND'}")

    ok = 0
    for n, cid, evt in pairs:
        eid = event_cache[evt]
        if not eid:
            results.append((n, cid, evt, "failed", "event record not found"))
            continue
        if not a.apply:
            results.append((n, cid, evt, "dry-run", ""))
            continue
        first, second = (cid, eid) if contact_first else (eid, cid)
        try:
            call("POST", "/associations/relations", {
                "locationId": loc, "associationId": a.association_id,
                "firstRecordId": first, "secondRecordId": second})
            results.append((n, cid, evt, "created", "")); ok += 1
        except RuntimeError as e:
            results.append((n, cid, evt, "failed", str(e)))
        time.sleep(0.15)

    with open(a.out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["sheet_row", "contact_id", "event_id", "status", "detail"])
        w.writerows(results)
    counts = {}
    for r in results:
        counts[r[3]] = counts.get(r[3], 0) + 1
    print(counts, "-> details in", a.out)
    if not a.apply:
        print("Dry run only. Re-run with --apply to create the relations.")


if __name__ == "__main__":
    main()
