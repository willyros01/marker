"""Looks in the apps' Gmail inbox for the email The Scorecard just sent.

usage: python3 inbox.py TO_ADDRESS "SUBJECT" SINCE_UNIX_SECONDS
Waits up to 3 minutes. Checks the title, that the button opens the Cuberoot
join page with Firebase's one-time code, and that a Forgot password link keeps
reset=1. Prints PASS/FAIL lines. Reads only; never deletes or sends anything.
"""
import base64, email, imaplib, os, re, sys, time
from email.utils import parsedate_to_datetime
from urllib.parse import urlparse, parse_qs

to, subject, since = sys.argv[1], sys.argv[2], float(sys.argv[3])
user, pw = os.environ["GMAIL_USER"], os.environ["GMAIL_PASS"].replace(" ", "")
JOIN = "https://www.cuberoot-systems.com/scorecard/join/"

def find():
    m = imaplib.IMAP4_SSL("imap.gmail.com", 993)
    m.login(user, pw)
    try:
        for box in ("INBOX", "[Gmail]/Spam"):
            if m.select(f'"{box}"', readonly=True)[0] != "OK":
                continue
            day = time.strftime("%d-%b-%Y", time.gmtime(since - 86400))
            ok, ids = m.search(None, "SINCE", day, "TO", f'"{to}"')
            for i in reversed((ids[0] or b"").split()):
                ok, data = m.fetch(i, "(RFC822)")
                msg = email.message_from_bytes(data[0][1])
                when = parsedate_to_datetime(msg["Date"]).timestamp()
                if when < since - 60:
                    continue
                return box, msg
    finally:
        m.logout()
    return None, None

end = time.time() + 180
box, msg = None, None
while time.time() < end and not msg:
    box, msg = find()
    if not msg:
        time.sleep(10)
if not msg:
    print(f"FAIL no email to {to} arrived within 3 minutes"); sys.exit(1)
bad = 0
def check(ok, name):
    global bad
    print(("PASS " if ok else "FAIL ") + name)
    bad += 0 if ok else 1
title = str(email.header.make_header(email.header.decode_header(msg["Subject"])))
check(box == "INBOX", f"the email landed in the inbox (found in {box})")
check(title == subject, f'the title is "{title}" (expected "{subject}")')
check(msg["From"] and "thescorecard.marker@gmail.com" in msg["From"], f"it comes from The Scorecard's Gmail ({msg['From']})")
html = ""
for part in msg.walk():
    if part.get_content_type() == "text/html":
        html = part.get_payload(decode=True).decode("utf-8")
links = [l.replace("&amp;", "&") for l in re.findall(r'href="([^"]+)"', html)]
link = links[0] if links else ""
u = urlparse(link)
q = parse_qs(u.query)
check(link.startswith(JOIN), f"the button opens the Cuberoot join page ({link[:60]}...)")
check(q.get("mode") == ["signIn"] and bool(q.get("oobCode")), "the link carries Firebase's one-time sign-in code")
check("firebaseapp.com" not in html, "no Firebase page in the email")
if "password" in subject.lower():
    cont = parse_qs(urlparse(q.get("continueUrl", [""])[0]).query)
    check(cont.get("reset") == ["1"], "the link is marked as a password change (reset=1)")
print("RESULT: " + ("FAILED" if bad else "all passed"))
sys.exit(1 if bad else 0)
