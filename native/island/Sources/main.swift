import AppKit

// kettu-island: the Dynamic Island's helper, started by Kettu's main process. It keeps the view
// main sends in step, draws it in the notch and sends back what the user does there.
//
// KETTU_ISLAND_DEBUG, which only a development run of Kettu passes on, is a comma-separated list:
//   log            log the view after each message
//   answer=STYLE   answer each new request once with its first option of STYLE, such as allow_once
//   expand         say the island was expanded once the first view arrived
//   drive          take `debug` messages on stdin, as a test script sends: their `kind` is expand,
//                  click, collapse or answer (the first request's first option)
//   floating       draw the island as on a screen without a notch
//   notch          keep to the screen with the notch, whichever display is in use

struct Debug {
  var log = false
  var answerStyle: String?
  var expand = false
  var drive = false
  var floating = false
  var notch = false

  init(_ value: String?) {
    for part in (value ?? "").split(separator: ",").map({ $0.trimmingCharacters(in: .whitespaces) })
    {
      if part == "log" || part == "1" {
        log = true
      } else if part == "expand" {
        expand = true
      } else if part == "drive" {
        drive = true
      } else if part == "floating" {
        floating = true
      } else if part == "notch" {
        notch = true
      } else if part.hasPrefix("answer=") {
        answerStyle = String(part.dropFirst("answer=".count))
      }
    }
  }
}

let debug = Debug(ProcessInfo.processInfo.environment["KETTU_ISLAND_DEBUG"])
// Every message is handled on the main thread, where the island is drawn.
let queue = DispatchQueue.main
let channel = Channel(queue: queue)
let store = Store()
let model = IslandModel(store: store, send: { channel.send($0) })
var ready = false
var expanded = false
var answered = Set<String>()
var nextAnswer = 1

func dump() {
  let summary = store.summary
  log(
    "view \(store.seq.map(String.init) ?? "-"): \(store.order.count) rows, "
      + "\(store.requestOrder.count) requests, running \(summary.running), "
      + "waiting \(summary.waiting), failed \(summary.failed)")
  guard debug.log else { return }
  for key in store.order {
    guard let row = store.rows[key] else { continue }
    let status = store.text(
      "status.\(store.status(of: row) == "sign_in" ? "signIn" : store.status(of: row))")
    let host =
      row.host.map { " @\($0.name)\($0.offline ? " (\(store.text("offline")))" : "")" } ?? ""
    let plan =
      row.plan.map { " " + store.text("plan", ["step": "\($0.step)", "total": "\($0.total)"]) }
      ?? ""
    let parent = row.parent.map { " ← \($0.kind) \($0.title ?? "?")" } ?? ""
    log("  [\(status)] \(row.agent.name) · \(row.title)\(host)\(parent) — \(row.line)\(plan)")
  }
  for key in store.requestOrder {
    guard let request = store.requests[key] else { continue }
    let options = request.options.map { "\($0.label) <\($0.style)>" }.joined(separator: " | ")
    log(
      "  ? \(request.kind): \(request.title) \(request.lines.first ?? "") → "
        + (options.isEmpty ? store.text("answerInKettu") : options))
  }
}

/// The development hook that answers for the user, through the same message a click would send.
func answerNew() {
  guard let style = debug.answerStyle else { return }
  for key in store.requestOrder where !answered.contains(key) {
    guard let request = store.requests[key],
      let option = request.options.first(where: { $0.style == style })
    else { continue }
    answered.insert(key)
    let id = "a\(nextAnswer)"
    nextAnswer += 1
    log("Answering \(key) with \(option.id) as \(id)")
    queue.asyncAfter(deadline: .now() + 1) {
      channel.send(.answer(id: id, request: key, option: option.id))
    }
  }
}

func handle(_ line: Data) {
  let message: MainMessage
  do {
    message = try JSONDecoder().decode(MainMessage.self, from: line)
  } catch {
    log("Could not read a message: \(error)")
    return
  }
  switch message.type {
  case "hello":
    store.hello(message)
    if let version = message.protocolVersion, version != islandProtocol {
      log("Kettu speaks protocol \(version), this helper \(islandProtocol)")
    }
    ready = true
    channel.send(.ready)
    log("Ready for Kettu \(message.version ?? "?") in \(store.locale), \(store.colorMode)")
  case "view":
    guard ready else { return }
    store.view(message)
    model.refresh()
    dump()
    answerNew()
    if debug.expand && !expanded {
      expanded = true
      channel.send(.expanded)
    }
  case "change":
    guard ready else { return }
    switch store.change(message) {
    case .applied:
      model.refresh()
      dump()
      answerNew()
    case .gap:
      log("A change came out of order; asking for the whole view")
      channel.send(.resync)
    }
  case "pop":
    log("Pop \(message.kind ?? "?") for \(message.row ?? "Kettu"): \(message.title ?? "")")
    model.pop(message)
  case "answered":
    let result = message.result ?? "?"
    log("Answer \(message.id ?? "?"): \(result)\(message.message.map { " (\($0))" } ?? "")")
    model.answered(message)
  case "strings":
    store.setStrings(message)
    model.refresh()
    log("Words now in \(store.locale)")
  case "appearance":
    if let mode = message.colorMode { store.setColorMode(mode) }
    log("Color mode now \(store.colorMode)")
  case "debug":
    guard debug.drive else { return log("Ignored a debug message") }
    switch message.kind {
    case "expand": model.expand(byClick: false)
    case "click": model.expand(byClick: true)
    case "collapse": model.collapse()
    case "answer":
      if let request = store.requestOrder.first.flatMap({ store.requests[$0] }),
        let option = request.options.first
      {
        model.answer(request, option: option)
      }
    default: log("Unknown debug action \(message.kind ?? "?")")
    }
  case "quit":
    log("Kettu asked the helper to quit")
    leave()
  default:
    log("Ignored a \(message.type) message")
  }
}

/// Shrinks the island back into the notch, then ends; main waits a second before it kills a helper
/// that is still running.
func leave() {
  model.leave()
  DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { exit(0) }
}

// An accessory app: no Dock icon, no menu bar of its own, never the active app.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = IslandController(model: model, floating: debug.floating, notchScreen: debug.notch)
channel.start(
  onLine: handle,
  onEnd: {
    // Main has gone, so nothing is left to show.
    leave()
  })
MarkImages.warmUp()
app.run()
