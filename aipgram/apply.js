// Points the Telegram-iOS sources at the AIPGram server (gramsrv) and rebrands the app.
// Idempotent: run `node aipgram/apply.js` from the repository root, also after merging upstream.
const fs = require("fs");
const path = require("path");

const SERVER_IP = "2.27.200.223";
const SERVER_PORT = 2398;
const APP_NAME = "Airagram";
const LINK_HOST = "airagram.top"; // public links (t.me on Telegram)
const OLD_LINK_HOST = "airagram.duckdns.org"; // previous domain; its links still open in the app
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

// 0. Domain move from a tree patched for the old host: generated links use the new host, and the host
//    lists that recognize our links get the new host first while keeping the old one.
function mustReplaceText(text, from, to, what) {
  if (!text.includes(from)) throw new Error("text not found: " + what);
  return text.replace(from, to);
}
for (const file of walkSwift(path.join(root, "submodules"))) {
  edit(path.relative(root, file), (t) => t
    .split(`"https://${OLD_LINK_HOST}/`).join(`"https://${LINK_HOST}/`)
    .split(`"${OLD_LINK_HOST}/`).join(`"${LINK_HOST}/`));
}
edit("submodules/UrlHandling/Sources/UrlHandling.swift", (t) => !t.includes(`    "${OLD_LINK_HOST}",\n`) || t.includes(`    "${LINK_HOST}",\n`) ? t :
  mustReplaceText(t, `    "${OLD_LINK_HOST}",\n`, `    "${LINK_HOST}",\n    "${OLD_LINK_HOST}",\n`, "old host in baseTelegramMePaths"));
edit("submodules/TelegramUI/Sources/OpenUrl.swift", (t) => !t.includes(`["${OLD_LINK_HOST}", "t.me"`) ? t :
  t.replace(`["${OLD_LINK_HOST}", "t.me"`, `["${LINK_HOST}", "${OLD_LINK_HOST}", "t.me"`));
edit("submodules/TelegramUI/Sources/Chat/ChatControllerOpenLinkContextMenu.swift", (t) => !t.includes(`if host == "${OLD_LINK_HOST}" ||`) ? t :
  t.replace(`if host == "${OLD_LINK_HOST}" ||`, `if host == "${LINK_HOST}" || host == "${OLD_LINK_HOST}" ||`));
edit("Telegram/BUILD", (t) => t.replace(/(<key>CFBundleDisplayName<\/key>\n\s*<string>)AIPGram(<\/string>)/g, `$1${APP_NAME}$2`));

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
edit("submodules/UrlHandling/Sources/UrlHandling.swift", (t) => t.includes(`    "${LINK_HOST}",\n`) ? t :
  mustReplace(t, /(private let baseTelegramMePaths = \[\n)(\s+"telegram\.me",)/, `$1    "${LINK_HOST}",\n$2`, "baseTelegramMePaths"));
edit("submodules/TelegramUI/Sources/OpenUrl.swift", (t) => t.includes(`telegramMeHosts: [String] = ["${LINK_HOST}"`) ? t :
  mustReplace(t, /telegramMeHosts: \[String\] = \["t\.me"/, `telegramMeHosts: [String] = ["${LINK_HOST}", "t.me"`, "telegramMeHosts"));
edit("submodules/TelegramUI/Sources/Chat/ChatControllerOpenLinkContextMenu.swift", (t) => t.includes(`host == "${LINK_HOST}"`) ? t :
  mustReplace(t, /if host == "t\.me" \|\|/, `if host == "${LINK_HOST}" || host == "t.me" ||`, "context menu host"));

// 5. Relative submodule URLs resolve against this repository; point them at the upstream ones.
edit(".gitmodules", (t) => t
  .replace(/url\s*=\s*\.\.\/rlottie\.git/, "url = https://github.com/TelegramMessenger/rlottie.git")
  .replace(/url\s*=\s*\.\.\/tgcalls\.git/, "url = https://github.com/TelegramMessenger/tgcalls.git"));

// 7. airagram:// (the scheme of the new link pages) is registered next to tg:// and the old aipgram://.
edit("Telegram/BUILD", (t) => t.includes("<string>airagram</string>") ? t :
  mustReplace(t, /( *)<string>tg<\/string>\n/, (m, indent) => m + `${indent}<string>airagram</string>\n`, "tg URL scheme"));

// 8. Sideloaded builds (Sideloadly, AltStore, free Apple IDs) often get no app group container. Upstream then
//    stops with an "Error 2" alert on an empty window: the black screen. Keep the data in the app's own
//    Library directory instead; only the extensions lose access to it.
edit("submodules/TelegramUI/Sources/AppDelegate.swift", (t) => t.includes("Airagram: no app group container") ? t :
  mustReplace(t,
    /        guard let appGroupUrl = maybeAppGroupUrl else \{\n            self\.mainWindow\?\.presentNative\(UIAlertController\(title: nil, message: "Error 2", preferredStyle: \.alert\)\)\n            return true\n        \}\n/,
    [
      "        // Airagram: no app group container (sideloaded build) -> use the app's own Library directory.",
      "        let appGroupUrl: URL",
      "        if let maybeAppGroupUrl {",
      "            appGroupUrl = maybeAppGroupUrl",
      "        } else {",
      '            appGroupUrl = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0].appendingPathComponent("AppGroup", isDirectory: true)',
      "            let _ = try? FileManager.default.createDirectory(at: appGroupUrl, withIntermediateDirectories: true)",
      "        }",
      "",
    ].join("\n"), "app group guard"));

// 9. The Airagram server speaks API layer 229. This client is generated for 230; the two differ only in a few
//    constructors, so the client announces 229 and also reads the 229 forms of botVerification and
//    botVerifierSettings (their descriptions were plain strings before 230).
edit("submodules/TelegramCore/Sources/State/Serialization.swift", (t) => t.includes("// Airagram: server layer") ? t :
  mustReplaceText(t, "    public func currentLayer() -> UInt {\n        return 230\n    }",
    "    public func currentLayer() -> UInt {\n        // Airagram: server layer\n        return 229\n    }", "currentLayer"));
edit("submodules/TelegramApi/Sources/Api0.swift", (t) => t.includes("dict[-113453988]") ? t :
  mustReplaceText(t, "    dict[-1591021569] = { return Api.BotVerifierSettings.parse_botVerifierSettings($0) }\n", [
    "    dict[-1591021569] = { return Api.BotVerifierSettings.parse_botVerifierSettings($0) }",
    "    // Airagram (layer 229): botVerification#f93cd45c bot_id:long icon:long description:string",
    "    dict[-113453988] = { reader in",
    "        guard let botId = reader.readInt64(), let icon = reader.readInt64(), let description = parseString(reader) else { return nil }",
    "        return Api.BotVerification.botVerification(Api.BotVerification.Cons_botVerification(botId: botId, icon: icon, description: .textWithEntities(Api.TextWithEntities.Cons_textWithEntities(text: description, entities: []))))",
    "    }",
    "    // Airagram (layer 229): botVerifierSettings#b0cd6617 flags:# icon:long company:string custom_description:flags.0?string",
    "    dict[-1328716265] = { reader in",
    "        guard let flags = reader.readInt32(), let icon = reader.readInt64(), let company = parseString(reader) else { return nil }",
    "        var customDescription: Api.TextWithEntities?",
    "        if Int(flags) & Int(1 << 0) != 0 {",
    "            guard let text = parseString(reader) else { return nil }",
    "            customDescription = .textWithEntities(Api.TextWithEntities.Cons_textWithEntities(text: text, entities: []))",
    "        }",
    "        return Api.BotVerifierSettings.botVerifierSettings(Api.BotVerifierSettings.Cons_botVerifierSettings(flags: flags, icon: icon, company: company, customDescription: customDescription))",
    "    }",
    ""].join("\n"), "botVerification parsers"));

// 11. Mini app header in the Telegram style: a glass capsule on the left (close icon + bot name) and "..." on the right,
//     no centred title. Applies to every bot Web App (the client used to show text buttons "Закрыть" for them).
edit("submodules/WebUI/Sources/WebAppController.swift", (t) => {
  if (t.includes("private var glassBotName")) return t;
  let s = t;
  s = mustReplaceText(s, "    private let isOnramp: Bool\n", "    private let isOnramp: Bool\n    private var glassBotName = \"\"\n", "glassBotName property");
  s = mustReplaceText(s, "        if !self.isVerifyAgeBot {\n            let titleView = WebAppTitleView(",
    "        self.glassBotName = params.botName\n        if !self.isVerifyAgeBot {\n            let titleView = WebAppTitleView(", "glassBotName init");
  s = mustReplaceText(s, "        var showGlassButtons = self.isOnramp\n", "        var showGlassButtons = true\n", "glass for all");
  s = mustReplaceText(s, `        if showGlassButtons {
            let barButtonSize = CGSize(width: 44.0, height: 44.0)
`, `        if showGlassButtons {
            let barButtonSize = CGSize(width: 44.0, height: 44.0)
            self.navigationItem.titleView = nil
            let closeSize = CGSize(width: self.controllerNode.hasBackButton ? 44.0 : min(240.0, 74.0 + CGFloat(self.glassBotName.count) * 9.0), height: 44.0)
            let closeIcon = AnyComponent(BundleIconComponent(
                name: self.controllerNode.hasBackButton ? "Navigation/Back" : "Navigation/Close",
                tintColor: self.presentationData.theme.chat.inputPanel.panelControlColor
            ))
            var closeContent = closeIcon
            if !self.controllerNode.hasBackButton && !self.glassBotName.isEmpty {
                closeContent = AnyComponent(HStack([
                    AnyComponentWithIdentity(id: "close", component: closeIcon),
                    AnyComponentWithIdentity(id: "title", component: AnyComponent(Text(
                        text: self.glassBotName,
                        font: Font.semibold(17.0),
                        color: self.presentationData.theme.chat.inputPanel.panelControlColor
                    )))
                ], spacing: 6.0))
            }
`, "capsule setup");
  s = mustReplaceText(s, `            let closeComponent: AnyComponentWithIdentity<Empty> = AnyComponentWithIdentity(
                id: "close",
                component: AnyComponent(GlassBarButtonComponent(
                    size: barButtonSize,
`, `            let closeComponent: AnyComponentWithIdentity<Empty> = AnyComponentWithIdentity(
                id: "close",
                component: AnyComponent(GlassBarButtonComponent(
                    size: closeSize,
`, "close size");
  s = mustReplaceText(s, `                    component: AnyComponentWithIdentity(id: self.controllerNode.hasBackButton ? "back" : "close", component: AnyComponent(
                        BundleIconComponent(
                            name: self.controllerNode.hasBackButton ? "Navigation/Back" : "Navigation/Close",
                            tintColor: self.presentationData.theme.chat.inputPanel.panelControlColor
                        )
                    )),
`, `                    component: AnyComponentWithIdentity(id: self.controllerNode.hasBackButton ? "back" : "close", component: closeContent),
`, "close content");
  s = mustReplaceText(s, "                cancelButtonNode = BarComponentHostNode(component: closeComponent, size: barButtonSize)\n",
    "                cancelButtonNode = BarComponentHostNode(component: closeComponent, size: closeSize)\n", "close host");
  return s;
});
