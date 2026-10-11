# Re-issues the build-system's fake provisioning profiles for the Airagram bundle id (run on the macOS CI runner
# before the build). The upstream fake profiles are bound to ph.telegra.Telegraph; Make.py picks profiles by
# application-identifier, so a new bundle id needs profiles that carry it. They are signed with the same
# self-signed identity (the build only reads them with `openssl smime -verify -noverify`).
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SIGNING = os.path.join(ROOT, "build-system", "fake-codesigning")
OLD_BUNDLE = b"ph.telegra.Telegraph"
NEW_BUNDLE = json.load(open(os.path.join(ROOT, "aipgram", "configuration.json")))["bundle_id"].encode()


def run(*args, **kw):
    return subprocess.run(args, check=True, capture_output=True, **kw).stdout


with tempfile.TemporaryDirectory() as tmp:
    pem = os.path.join(tmp, "identity.pem")
    p12 = os.path.join(SIGNING, "certs", "SelfSigned.p12")
    # OpenSSL 3 needs -legacy for the RC2-encrypted .p12; LibreSSL and OpenSSL 1.1 do not know the flag.
    for extra in (["-legacy"], []):
        try:
            run("openssl", "pkcs12", *extra, "-in", p12, "-nodes", "-passin", "pass:", "-out", pem)
            break
        except subprocess.CalledProcessError as e:
            print("openssl pkcs12 %s failed: %s" % (" ".join(extra) or "(plain)", e.stderr.decode(errors="replace").strip()[:300]))
    else:
        sys.exit("cannot read the self-signed identity")
    profiles = os.path.join(SIGNING, "profiles")
    for name in sorted(os.listdir(profiles)):
        if not name.endswith(".mobileprovision"):
            continue
        path = os.path.join(profiles, name)
        plist = run("openssl", "smime", "-inform", "der", "-verify", "-noverify", "-in", path)
        if NEW_BUNDLE in plist and OLD_BUNDLE not in plist:
            print("already", name)
            continue
        plist_path = os.path.join(tmp, name + ".plist")
        open(plist_path, "wb").write(plist.replace(OLD_BUNDLE, NEW_BUNDLE))
        run("openssl", "smime", "-sign", "-signer", pem, "-inkey", pem, "-nodetach", "-outform", "der",
            "-in", plist_path, "-out", path)
        print("reissued", name)
sys.exit(0)
