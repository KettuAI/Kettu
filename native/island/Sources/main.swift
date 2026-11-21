import Foundation

// kettu-island: the Dynamic Island's helper, started by Kettu's main process. This first version
// keeps the view main sends in step and answers through main; it draws nothing yet.
//
// KETTU_ISLAND_DEBUG, which only a development run of Kettu passes on, is a comma-separated list:
//   log            log the view after each message
//   answer=STYLE   answer each new request once with its first option of STYLE, such as allow_once
//   expand         say the island was expanded once the first view arrived

struct Debug {
  var log = false
  var answerStyle: String?
  var expand = false

  init(_ value: String?) {
    for part in (value ?? "").split(separator: ",").map({ $0.trimmingCharacters(in: .whitespaces) })
    {
      if part == "log" || part == "1" {
        log = true
      } else if part == "expand" {
        expand = true
      } else if part.hasPrefix("answer=") {
        answerStyle = String(part.dropFirst("answer=".count))
      }
    }
  }
}

let debug = Debug(ProcessInfo.processInfo.environment["KETTU_ISLAND_DEBUG"])
let queue = DispatchQueue(label: "sh.kettu.island")
let channel = Channel(queue: queue)
let store = Store()
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
    let status = store.text("status.\(store.status(of: row) == "sign_in" ? "signIn" : store.status(of: row))")
    let host = row.host.map { " @\($0.name)\($0.offline ? " (\(store.text("offline")))" : "")" } ?? ""
    let plan = row.plan.map { " " + store.text("plan", ["done": "\($0.done)", "total": "\($0.total)"]) } ?? ""
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
      dump()
      answerNew()
    case .gap:
      log("A change came out of order; asking for the whole view")
      channel.send(.resync)
    }
  case "pop":
    log("Pop \(message.kind ?? "?") for \(message.row ?? "Kettu"): \(message.title ?? "")")
  case "answered":
    let result = message.result ?? "?"
    log("Answer \(message.id ?? "?"): \(result)\(message.message.map { " (\($0))" } ?? "")")
  case "strings":
    store.setStrings(message)
    log("Words now in \(store.locale)")
  case "appearance":
    if let mode = message.colorMode { store.setColorMode(mode) }
    log("Color mode now \(store.colorMode)")
  case "quit":
    log("Kettu asked the helper to quit")
    exit(0)
  default:
    log("Ignored a \(message.type) message")
  }
}

channel.start(
  onLine: handle,
  onEnd: {
    // Main has gone, so nothing is left to show.
    exit(0)
  })
dispatchMain()
