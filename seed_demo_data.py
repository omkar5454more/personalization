"""Seeds SYNTHETIC visitors into the local test site so heatmap/funnel UIs have data to show.
   python seed_demo_data.py            add 60 fake visitors (server must be running)
   python seed_demo_data.py --remove   delete them again"""
import json, random, sqlite3, sys, urllib.request

if "--remove" in sys.argv:  # delete everything this script created (visitor ids start with "seed")
    con = sqlite3.connect("data.db")
    n = con.execute("DELETE FROM events WHERE visitor_id LIKE 'seed%'").rowcount
    con.commit()
    print("removed", n, "synthetic events")
    sys.exit()

random.seed(7)
SITE = "site_304d14c7db"
URL = "http://127.0.0.1:8010/collect"


def post(events):
    req = urllib.request.Request(URL, data=json.dumps({"site": SITE, "host": "localhost", "events": events}).encode(), method="POST")
    urllib.request.urlopen(req).read()


def click(vid, sid, pid, url, sel, text, x, y, dw, dh, device):
    return {"vid": vid, "sid": sid, "type": "autoclick", "url": url, "visit_no": 1, "returning": False,
            "props": {"pid": pid, "sel": sel, "text": text, "tag": "button", "key": sel + "|" + text, "x": x, "y": y, "dw": dw, "dh": dh, "device": device}}


N = 60
for i in range(N):
    vid, sid, pid = f"seed{i:04d}aaaabbbb", f"sess{i}", f"pid{i}"
    device = random.choice(["desktop", "desktop", "desktop", "mobile", "tablet"])
    dw, dh, vh = (1280, 2100, 700) if device == "desktop" else (390, 3400, 780)
    ev = [{"vid": vid, "sid": sid, "type": "pageview", "url": "/demo", "visit_no": 1, "returning": i % 3 == 0,
           "props": {"pid": pid, "device": device, "title": "Demo store", "ref": random.choice(["", "google.com", "twitter.com"])}}]
    # clicks cluster around the two hero buttons and the nav; some random strays
    for _ in range(random.randint(1, 4)):
        r = random.random()
        if r < 0.45:
            ev.append(click(vid, sid, pid, "/demo", "button#buy-button", "Buy now", random.gauss(34, 2), random.gauss(240, 12), dw, dh, device))
        elif r < 0.65:
            ev.append(click(vid, sid, pid, "/demo", "button#wishlist", "Add to wishlist", random.gauss(48, 2), random.gauss(240, 12), dw, dh, device))
        elif r < 0.85:
            ev.append(click(vid, sid, pid, "/demo", "a", "Pricing (SPA route)", random.gauss(22, 3), random.gauss(35, 5), dw, dh, device))
        else:
            ev.append(click(vid, sid, pid, "/demo", "div", "", random.uniform(5, 95), random.uniform(100, dh - 100), dw, dh, device))
    reach = random.choices([25, 50, 75, 100], weights=[30, 30, 25, 15])[0]
    for d in (25, 50, 75, 100):
        if d <= reach:
            ev.append({"vid": vid, "sid": sid, "type": "scroll", "url": "/demo", "visit_no": 1, "returning": False, "props": {"pid": pid, "depth": d}})
    ev.append({"vid": vid, "sid": sid, "type": "engage", "url": "/demo", "visit_no": 1, "returning": False,
               "props": {"pid": pid, "seconds": random.randint(3, 90), "scroll": reach, "device": device, "vh": vh}})
    # funnel: home -> pricing -> purchase (drop-offs on the way)
    if random.random() < 0.62:
        ev.append({"vid": vid, "sid": sid, "type": "pageview", "url": "/demo/pricing", "visit_no": 1, "returning": i % 3 == 0, "props": {"pid": pid + "p", "device": device}})
        if random.random() < 0.34:
            ev.append({"vid": vid, "sid": sid, "type": "event", "name": "purchase", "url": "/demo/pricing", "visit_no": 1, "returning": i % 3 == 0, "props": {}})
    post(ev)
print("seeded", N, "synthetic visitors")
