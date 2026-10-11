// Points the Telegram-iOS sources at the AIPGram server (gramsrv) and rebrands the app.
// Idempotent: run `node aipgram/apply.js` from the repository root, also after merging upstream.
const fs = require("fs");
const path = require("path");

const SERVER_IP = "2.27.200.223";
const SERVER_PORT = 2398;
const APP_NAME = "AIPGram";
const LINK_HOST = "aipgram.duckdns.org"; // public links (t.me on Telegram)
const RSA_KEY = [
  "-----BEGIN RSA PUBLIC KEY-----",
  "MIIBCgKCAQEAuwI+651GHh3hcvtJZmZbFw6KvldOtxcsdBe95Woa6mnRoIz4xQBq",
  "yFaLNnzKFRawuh8++7x2kup+XZY+rlSAmEqLcNTSMyqcPkON/YMujSbpZrm0Q3Sy",
  "IJrALPUmq/oUEedldmf0mqDGvUylqY6iKSaEA9oD2AXRupFqvZEc3c90ZsYmog7J",
  "N9nwtBch+bsPEWaTkOjUUJQlpwP3UTAa2bvCusu8P5cQPp1RjeKj8MUPkgWwmL/N",
  "4EgdboJEdP6Ew7/Ie99hZQYmze5enwN990wrgJ9/kX4KzDYil3R0wSFdN3gem9uy",
  "jmlmZH5ZKn2JgO5scJpswZ7oqYTTysyWlwIDAQAB",
  "-----END RSA PUBLIC KEY-----",
];

const root = path.resolve(__dirname, "..");
function edit(rel, fn) {
  const file = path.join(root, rel);
  const before = fs.readFileSync(file, "utf8");
  const after = fn(before);
  if (after === before) {
    console.log("unchanged", rel);
    return;
  }
  fs.writeFileSync(file, after);
  console.log("patched  ", rel);
}
function mustReplace(text, re, replacement, what) {
  if (!re.test(text)) throw new Error("pattern not found: " + what);
  return text.replace(re, replacement);
}

// 1. Seed data centers: every DC (production and test) is the AIPGram server, on its port.
edit("submodules/TelegramCore/Sources/Network/Network.swift", (t) => {
  const list = (ids) => "[\n" + ids.map((id) => `                    ${id}: ["${SERVER_IP}"]`).join(",\n") + "\n                ]";
  // The first assignment is the test backend, the second production.
  const lists = [list([1, 2, 3]), list([1, 2, 3, 4, 5])];
  let seen = 0;
  t = t.replace(/(seedAddressList = )\[\n\s+1: \[[\s\S]*?\n\s+\]/g, (_, head) => head + (lists[seen++] ?? lists[1]));
  if (seen !== 2) throw new Error("expected 2 seed lists, found " + seen);
  return t.replace(
    /(MTDatacenterAddressSet\(addressList: ips\.map \{ MTDatacenterAddress\(ip: \$0, port: )\d+/,
    `$1${SERVER_PORT}`,
  );
});

// 2. Server RSA key for the auth-key handshake (both backends).
edit("submodules/MtProtoKit/Sources/MTDatacenterAuthMessageService.m", (t) => {
  const pem = RSA_KEY.map((line, i) => `"${line}${i < RSA_KEY.length - 1 ? "\\n" : ""}"`).join("\n             ");
  const key = `[[MTDatacenterAuthPublicKey alloc] initWithPublicKey:@${pem}]`;
  t = mustReplace(t, /(testingPublicKeys = @\[\n\s+)\[\[MTDatacenterAuthPublicKey alloc\][\s\S]*?-----END RSA PUBLIC KEY-----"\]/, `$1${key}`, "testing keys");
  return mustReplace(t, /(productionPublicKeys = @\[\n\s+)\[\[MTDatacenterAuthPublicKey alloc\][\s\S]*?-----END RSA PUBLIC KEY-----"\]/, `$1${key}`, "production keys");
});

// 3. App name shown on the home screen; register aipgram:// (the scheme of our public link pages,
//    handled like tg:// through app_specific_url_scheme in aipgram/configuration.json).
edit("Telegram/BUILD", (t) => {
  t = t.replace(/(<key>CFBundleDisplayName<\/key>\n\s*<string>)Telegram(<\/string>)/g, `$1${APP_NAME}$2`);
  if (t.includes("<string>aipgram</string>")) return t;
  return mustReplace(t, /( *)<string>tg<\/string>\n/, (m, indent) => m + `${indent}<string>aipgram</string>\n`, "tg URL scheme");
});

// 4. Public links live on our domain instead of t.me: generated links use it, and links on it open
//    inside the app (t.me ones still do too).
function walkSwift(dir, out = []) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "Tests" || entry.name.startsWith(".")) continue;
      walkSwift(full, out);
    } else if (entry.name.endsWith(".swift")) {
      out.push(full);
    }
  }
  return out;
}
for (const file of walkSwift(path.join(root, "submodules"))) {
  edit(path.relative(root, file), (t) => t
    .split('"https://t.me/').join(`"https://${LINK_HOST}/`)
    .split('"t.me/').join(`"${LINK_HOST}/`));
}
edit("submodules/UrlHandling/Sources/UrlHandling.swift", (t) => t.includes(`"${LINK_HOST}",\n    "telegram.me"`) ? t :
  mustReplace(t, /(private let baseTelegramMePaths = \[\n)(\s+"telegram\.me",)/, `$1    "${LINK_HOST}",\n$2`, "baseTelegramMePaths"));
edit("submodules/TelegramUI/Sources/OpenUrl.swift", (t) => t.includes(`telegramMeHosts: [String] = ["${LINK_HOST}"`) ? t :
  mustReplace(t, /telegramMeHosts: \[String\] = \["t\.me"/, `telegramMeHosts: [String] = ["${LINK_HOST}", "t.me"`, "telegramMeHosts"));
edit("submodules/TelegramUI/Sources/Chat/ChatControllerOpenLinkContextMenu.swift", (t) => t.includes(`host == "${LINK_HOST}"`) ? t :
  mustReplace(t, /if host == "t\.me" \|\|/, `if host == "${LINK_HOST}" || host == "t.me" ||`, "context menu host"));

// 5. Relative submodule URLs resolve against this repository; point them at the upstream ones.
edit(".gitmodules", (t) => t
  .replace(/url\s*=\s*\.\.\/rlottie\.git/, "url = https://github.com/TelegramMessenger/rlottie.git")
  .replace(/url\s*=\s*\.\.\/tgcalls\.git/, "url = https://github.com/TelegramMessenger/tgcalls.git"));
