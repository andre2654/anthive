// The menu bar companion: a hexagon in the menu bar; a click opens a panel with
// the hive — two big tiles (running, needs you), what needs you with Allow/Deny,
// the projects with their agents, and your limits as big numbers in the footer.
// It reads `anthive status --json` every ten seconds and never touches the store;
// the only thing it writes is an answer to a permission request, through
// `anthive decide`, the same path the TUI uses.
import Cocoa
import SwiftUI
import UserNotifications
import ServiceManagement

// MARK: - the snapshot, as `anthive status --json` prints it
struct Limits: Decodable { let fiveHour: Double; let sevenDay: Double; let resetsAt: Double; let seenAt: Double? }
struct Agent: Decodable, Identifiable { let id: String; let name: String; let state: String; let ageMs: Double; let doing: String; let context: Double; let branch: String; let model: String }
struct Need: Decodable, Identifiable { let kind: String; let id: String; let agent: String; let agentId: String; let text: String; let tool: String? }
struct Project: Decodable, Identifiable { let id: String; let name: String; let cwd: String; let running: Int; let agents: [Agent]; let needs: [Need] }
struct Status: Decodable { let at: Double; let running: Int; let needs: Int; let limits: Limits?; let projects: [Project] }

func ago(_ ms: Double) -> String {
  let s = Int(max(0, ms / 1000))
  if s < 60 { return "\(s)s" }
  let m = s / 60
  if m < 60 { return "\(m)m" }
  let h = m / 60
  if h < 24 { return "\(h)h" }
  return "\(h / 24)d"
}
func hhmm(_ ms: Double) -> String { let f = DateFormatter(); f.dateFormat = "HH:mm"; return f.string(from: Date(timeIntervalSince1970: ms / 1000)) }
func dlog(_ msg: String) {
  guard ProcessInfo.processInfo.environment["ANTHIVE_MENUBAR_LOG"] != nil else { return }
  let line = "\(Date()) \(msg)\n"
  if let h = FileHandle(forWritingAtPath: "/tmp/anthive-menubar.log") { h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); h.closeFile() }
  else { try? line.write(toFile: "/tmp/anthive-menubar.log", atomically: true, encoding: .utf8) }
}
func trunc(_ s: String, _ n: Int) -> String { s.count > n ? String(s.prefix(n - 1)).trimmingCharacters(in: .whitespaces) + "…" : s }

// MARK: - the model: reads the hive, answers requests, opens the terminal
final class Model: ObservableObject {
  @Published var status: Status?
  @Published var error = ""
  @Published var updatedAt = Date()
  @Published var loginEnabled = false
  var seenNeeds = Set<String>()
  var firstLoad = true

  var anthive: String? {
    if let p = UserDefaults.standard.string(forKey: "anthive"), FileManager.default.isExecutableFile(atPath: p) { return p }
    let home = NSHomeDirectory()
    for p in ["\(home)/.local/bin/anthive", "/opt/homebrew/bin/anthive", "/usr/local/bin/anthive"] {
      if FileManager.default.isExecutableFile(atPath: p) { return p }
    }
    return nil
  }

  func run(_ args: [String]) -> Data? {
    guard let bin = anthive else { DispatchQueue.main.async { self.error = "anthive not found — defaults write dev.anthive.menubar anthive /path/to/anthive" }; return nil }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: bin)
    p.arguments = args
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
    p.environment = env
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { DispatchQueue.main.async { self.error = "could not run anthive: \(error.localizedDescription)" }; return nil }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return data
  }

  func refresh() {
    DispatchQueue.global(qos: .utility).async { [weak self] in
      guard let self = self, let data = self.run(["status", "--json"]) else { return }
      if let s = try? JSONDecoder().decode(Status.self, from: data) {
        DispatchQueue.main.async { self.error = ""; self.apply(s) }
      } else {
        DispatchQueue.main.async { self.error = "anthive status gave something I could not read" }
      }
    }
  }

  func apply(_ s: Status) {
    dlog("snapshot projects=\(s.projects.count) running=\(s.running) needs=\(s.needs)")
    status = s
    updatedAt = Date()
    let ids = Set(s.projects.flatMap { $0.needs.map { $0.id } })
    if !firstLoad { for id in ids.subtracting(seenNeeds) { if let n = s.projects.flatMap({ $0.needs }).first(where: { $0.id == id }) { notify(n) } } }
    seenNeeds = ids
    firstLoad = false
    if #available(macOS 13.0, *) { loginEnabled = SMAppService.mainApp.status == .enabled }
    NotificationCenter.default.post(name: .anthiveUpdated, object: nil)
  }

  func notify(_ n: Need) {
    guard Bundle.main.bundleIdentifier != nil else { return }
    let c = UNMutableNotificationContent()
    c.title = n.kind == "approval" ? "An agent asks for permission" : n.kind == "stuck" ? "An agent is stuck" : "A conversation ran out of turns"
    c.body = n.text
    c.sound = .default
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: n.id, content: c, trigger: nil))
  }

  func decide(_ id: String, _ how: String) {
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in _ = self?.run(["decide", id, how]); self?.refresh() }
  }

  func toggleLogin() {
    if #available(macOS 13.0, *) {
      do { if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() } else { try SMAppService.mainApp.register() } } catch let e { self.error = "login item: \(e.localizedDescription)" }
      loginEnabled = SMAppService.mainApp.status == .enabled
    }
  }

  // Ghostty when it is there (with a one-file script, which is how its CLI takes a command); Terminal otherwise.
  func openTerminal(_ project: String?) {
    guard let bin = anthive else { return }
    let script = "\(NSHomeDirectory())/.anthive/menubar-open.sh"
    let cmd = "exec \"\(bin)\"" + (project.map { " \"\($0)\"" } ?? "")
    try? "#!/bin/sh\n\(cmd)\n".write(toFile: script, atomically: true, encoding: .utf8)
    chmod(script, 0o755)
    let ghostty = "/Applications/Ghostty.app/Contents/MacOS/ghostty"
    if FileManager.default.isExecutableFile(atPath: ghostty) {
      let p = Process(); p.executableURL = URL(fileURLWithPath: ghostty); p.arguments = ["-e", script]
      try? p.run()
    } else {
      let src = "tell application \"Terminal\"\nactivate\ndo script \"\(cmd.replacingOccurrences(of: "\"", with: "\\\""))\"\nend tell"
      NSAppleScript(source: src)?.executeAndReturnError(nil)
    }
  }
}
extension Notification.Name { static let anthiveUpdated = Notification.Name("anthiveUpdated") }

// MARK: - the panel
struct Tile: View {
  let title: String; let value: String; let caption: String; let color: Color; let active: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(title).font(.system(size: 12, weight: .semibold)).foregroundStyle(active ? Color.white.opacity(0.85) : Color.secondary)
      Text(value).font(.system(size: 44, weight: .bold, design: .rounded)).foregroundStyle(active ? Color.white : Color.primary).padding(.top, 2)
      Spacer(minLength: 6)
      Text(caption).font(.system(size: 12, weight: .medium)).foregroundStyle(active ? Color.white.opacity(0.92) : Color.secondary).lineLimit(2).fixedSize(horizontal: false, vertical: true)
    }
    .padding(16)
    .frame(maxWidth: .infinity, minHeight: 138, alignment: .topLeading)
    .background(active ? color : Color(nsColor: .controlBackgroundColor))
  }
}

struct Badge: View {
  let text: String; let ok: Bool
  var body: some View {
    HStack(spacing: 4) { Image(systemName: ok ? "checkmark.circle.fill" : "exclamationmark.circle.fill"); Text(text) }
      .font(.system(size: 11, weight: .semibold)).foregroundStyle(ok ? Color.primary : Color.orange)
      .padding(.horizontal, 8).padding(.vertical, 3).background(Capsule().fill(Color.primary.opacity(0.08)))
  }
}

struct SectionTitle: View {
  let text: String
  var body: some View { Text(text.uppercased()).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 4) }
}

struct NeedRow: View {
  let need: Need; let project: Project; @ObservedObject var model: Model
  var body: some View {
    let icon = need.kind == "stuck" ? "xmark.octagon.fill" : need.kind == "exhausted" ? "pause.circle.fill" : "exclamationmark.triangle.fill"
    let color: Color = need.kind == "stuck" ? .red : .orange
    let title = need.kind == "approval" ? "\(need.agent) asks to run \(need.tool ?? "a tool")" : need.text
    let detail = need.kind == "approval" ? need.text.components(separatedBy: ": ").dropFirst().joined(separator: ": ") : (need.kind == "stuck" ? "No answer from the tool for a while" : "The conversation ran out of turns")
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: icon).foregroundStyle(color).font(.system(size: 15)).frame(width: 20).padding(.top, 1)
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.system(size: 13, weight: .semibold))
        Text(detail).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2)
      }
      Spacer(minLength: 8)
      if need.kind == "approval" {
        HStack(spacing: 6) {
          Button("Allow") { model.decide(need.id, "allow") }.buttonStyle(.borderedProminent).tint(.green).controlSize(.small)
          Button("Deny") { model.decide(need.id, "deny") }.buttonStyle(.bordered).controlSize(.small)
        }
      } else {
        Button("Open") { model.openTerminal(project.id) }.buttonStyle(.bordered).controlSize(.small)
      }
    }
    .padding(.horizontal, 16).padding(.vertical, 8)
  }
}

struct ProjectRow: View {
  let project: Project; @ObservedObject var model: Model
  func stateColor(_ s: String) -> Color { s == "running" ? .green : s == "waiting" ? .orange : s == "stuck" ? .red : .secondary }
  var body: some View {
    let awake = project.agents.filter { $0.state != "sleeping" }
    let asleep = project.agents.count - awake.count
    let summary = [project.running > 0 ? "\(project.running) running" : nil, asleep > 0 ? "\(asleep) asleep" : nil, project.agents.isEmpty ? "no agents" : nil].compactMap { $0 }.joined(separator: " · ")
    Button { model.openTerminal(project.id) } label: {
      VStack(alignment: .leading, spacing: 5) {
        HStack(spacing: 8) {
          Circle().fill(project.running > 0 ? Color.green : Color.secondary.opacity(0.35)).frame(width: 8, height: 8)
          Text(project.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
          Spacer()
          Text(summary).font(.system(size: 11)).foregroundStyle(.secondary)
        }
        ForEach(awake) { a in
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(a.name).font(.system(size: 11, weight: .semibold)).foregroundStyle(stateColor(a.state))
            Text(a.state + (a.ageMs >= 0 ? " · " + ago(a.ageMs) : "")).font(.system(size: 11)).foregroundStyle(.secondary)
            if !a.doing.isEmpty { Text(trunc(a.doing, 60)).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1) }
          }.padding(.leading, 16)
        }
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .padding(.horizontal, 16).padding(.vertical, 8)
  }
}

struct Footer: View {
  let limits: Limits?
  var body: some View {
    HStack(alignment: .top, spacing: 0) {
      VStack(alignment: .leading, spacing: 4) {
        Text("5-hour window").font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(limits.map { "\(Int($0.fiveHour * 100))%" } ?? "—").font(.system(size: 28, weight: .bold, design: .rounded))
          if let l = limits { Badge(text: "resets \(hhmm(l.resetsAt))", ok: l.fiveHour < 0.9) }
        }
        if limits == nil { Text("unknown until a chat runs").font(.system(size: 11)).foregroundStyle(.secondary) }
      }.padding(16).frame(maxWidth: .infinity, alignment: .topLeading)
      Divider().padding(.vertical, 12)
      VStack(alignment: .leading, spacing: 4) {
        Text("7-day window").font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
        Text(limits.map { "\(Int($0.sevenDay * 100))%" } ?? "—").font(.system(size: 28, weight: .bold, design: .rounded))
      }.padding(16).frame(maxWidth: .infinity, alignment: .topLeading)
    }
    .background(Color.primary.opacity(0.05))
  }
}

struct HiveView: View {
  @ObservedObject var model: Model
  var body: some View {
    VStack(spacing: 0) {
      // header: name, when it was read, refresh, settings
      HStack(spacing: 10) {
        Image(systemName: "hexagon.fill").font(.system(size: 14)).foregroundStyle(.secondary)
        Text("Anthive").font(.system(size: 15, weight: .semibold))
        Spacer()
        if model.status != nil { Text("updated \(ago(Date().timeIntervalSince(model.updatedAt) * 1000)) ago").font(.system(size: 11)).foregroundStyle(.secondary) }
        Button { model.refresh() } label: { Image(systemName: "arrow.clockwise") }.buttonStyle(.plain).foregroundStyle(.secondary)
        Menu {
          Button(model.loginEnabled ? "Open at Login  ✓" : "Open at Login") { model.toggleLogin() }
          Divider()
          Button("Quit Anthive") { NSApp.terminate(nil) }
        } label: { Image(systemName: "gearshape").foregroundStyle(.secondary) }.menuStyle(.borderlessButton).menuIndicator(.hidden).frame(width: 22)
      }.padding(.horizontal, 16).padding(.vertical, 12)
      if let s = model.status {
        let needs = s.projects.flatMap { p in p.needs.map { (p, $0) } }
        let runningNames = s.projects.flatMap { $0.agents.filter { $0.state == "running" || $0.state == "waiting" }.map { $0.name } }
        HStack(spacing: 0) {
          Tile(title: "Running", value: "\(s.running)", caption: runningNames.isEmpty ? "Every agent is resting" : runningNames.prefix(4).joined(separator: ", ") + (runningNames.count > 4 ? " +\(runningNames.count - 4)" : ""), color: Color(red: 0.16, green: 0.62, blue: 0.42), active: s.running > 0)
          Tile(title: "Needs you", value: "\(s.needs)", caption: needs.first.map { $0.1.kind == "approval" ? "\($0.1.agent) asks to run \($0.1.tool ?? "a tool")" : $0.1.text } ?? "Nothing waiting on you", color: Color(red: 0.86, green: 0.53, blue: 0.13), active: s.needs > 0)
        }
        if !needs.isEmpty {
          SectionTitle(text: "Needs you")
          ForEach(needs, id: \.1.id) { p, n in NeedRow(need: n, project: p, model: model) }
        }
        if !s.projects.isEmpty {
          SectionTitle(text: "Projects")
          ForEach(s.projects) { p in ProjectRow(project: p, model: model) }
          Spacer(minLength: 8)
        } else {
          Text("No project with agents yet").font(.system(size: 12)).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(16)
        }
        Footer(limits: s.limits)
      } else {
        Text(model.error.isEmpty ? "Reading the hive…" : model.error).font(.system(size: 12)).foregroundStyle(.secondary).padding(24)
      }
    }
    .frame(width: 400)
  }
}

// MARK: - the status item and its popover
final class AppDelegate: NSObject, NSApplicationDelegate {
  let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  let model = Model()
  let popover = NSPopover()
  var timer: Timer?

  func applicationDidFinishLaunching(_ n: Notification) {
    item.button?.image = NSImage(systemSymbolName: "hexagon", accessibilityDescription: "anthive")
    item.button?.image?.isTemplate = true
    item.button?.target = self
    item.button?.action = #selector(toggle)
    let host = NSHostingController(rootView: HiveView(model: model))
    if #available(macOS 13.0, *) { host.sizingOptions = [.preferredContentSize] }
    popover.contentViewController = host
    popover.behavior = .transient
    popover.animates = true
    if Bundle.main.bundleIdentifier != nil { UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in } }
    NotificationCenter.default.addObserver(self, selector: #selector(updated), name: .anthiveUpdated, object: nil)
    model.refresh()
    timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in self?.model.refresh() }
    if ProcessInfo.processInfo.environment["ANTHIVE_MENUBAR_OPEN"] != nil { DispatchQueue.main.asyncAfter(deadline: .now() + 4) { self.toggle() } }   // test hook: open the panel by itself
  }

  @objc func toggle() {
    dlog("toggle shown=\(popover.isShown)")
    if popover.isShown { popover.performClose(nil); return }
    guard let b = item.button else { return }
    model.refresh()
    NSApp.activate(ignoringOtherApps: true)   // before the popover: a transient popover shown by an inactive app can close on activation
    popover.show(relativeTo: b.bounds, of: b, preferredEdge: .minY)
    dlog("after show: shown=\(popover.isShown) windows=\(NSApp.windows.count)")
    if let path = ProcessInfo.processInfo.environment["ANTHIVE_MENUBAR_SNAP"] { DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { self.snapshot(to: path) } }   // test hook: the panel draws itself to a PNG
  }

  /// The panel rendered to a file, so a script can look at it: the content on the window background.
  func snapshot(to path: String) {
    guard let v = popover.contentViewController?.view else { return }
    v.layoutSubtreeIfNeeded()
    guard let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return }
    v.cacheDisplay(in: v.bounds, to: rep)
    let out = NSImage(size: v.bounds.size)
    out.lockFocus()
    NSColor.windowBackgroundColor.setFill(); v.bounds.fill()
    if let cg = rep.cgImage { NSImage(cgImage: cg, size: v.bounds.size).draw(in: v.bounds) }
    out.unlockFocus()
    if let tiff = out.tiffRepresentation, let r2 = NSBitmapImageRep(data: tiff), let png = r2.representation(using: .png, properties: [:]) { try? png.write(to: URL(fileURLWithPath: path)) }
    dlog("snapshot written to \(path) size=\(v.bounds.size)")
  }

  // the icon: filled while something runs, the running count, orange when something needs you
  @objc func updated() {
    guard let b = item.button, let s = model.status else { return }
    b.image = NSImage(systemSymbolName: s.running > 0 ? "hexagon.fill" : "hexagon", accessibilityDescription: "anthive")
    b.image?.isTemplate = true
    b.contentTintColor = s.needs > 0 ? .systemOrange : nil
    var title = s.running > 0 ? " \(s.running)" : ""
    if s.needs > 0 { title += " ◆\(s.needs)" }
    if let l = s.limits, l.fiveHour >= 0.8 { title += "  \(Int(l.fiveHour * 100))%" }
    b.title = title
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
