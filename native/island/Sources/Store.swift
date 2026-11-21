import Foundation

/// The view as main last sent it, kept in step through numbered changes. A change whose number
/// does not follow the last one means one was lost, so the whole view is asked for again.
final class Store {
  private(set) var strings: [String: String] = [:]
  private(set) var locale = "en"
  private(set) var colorMode = "light"
  private(set) var stuckAfterMs: Double = 5 * 60_000
  private(set) var seq: Int?
  private(set) var rows: [String: IslandRow] = [:]
  private(set) var order: [String] = []
  private(set) var requests: [String: IslandRequest] = [:]
  private(set) var requestOrder: [String] = []
  private(set) var notices: [IslandNotice] = []
  private(set) var summary = IslandSummary(
    running: 0, waiting: 0, failed: 0, today: 0)

  enum Outcome {
    case applied
    /// A change came out of order; the view is stale until a whole one arrives.
    case gap
  }

  func hello(_ message: MainMessage) {
    if let strings = message.strings { self.strings = strings }
    if let locale = message.locale { self.locale = locale }
    if let colorMode = message.colorMode { self.colorMode = colorMode }
    if let stuck = message.stuckAfterMs { stuckAfterMs = stuck }
  }

  func setStrings(_ message: MainMessage) {
    if let strings = message.strings { self.strings = strings }
    if let locale = message.locale { self.locale = locale }
  }

  func setColorMode(_ mode: String) {
    colorMode = mode
  }

  func view(_ message: MainMessage) {
    let rows = message.rows ?? []
    let requests = message.requests ?? []
    self.rows = Dictionary(rows.map { ($0.key, $0) }, uniquingKeysWith: { _, last in last })
    order = rows.map(\.key)
    self.requests = Dictionary(
      requests.map { ($0.key, $0) }, uniquingKeysWith: { _, last in last })
    requestOrder = requests.map(\.key)
    notices = message.notices ?? []
    if let summary = message.summary { self.summary = summary }
    seq = message.seq
  }

  func change(_ message: MainMessage) -> Outcome {
    guard let next = message.seq, let last = seq, next == last + 1 else {
      seq = nil
      return .gap
    }
    seq = next
    for key in message.removedRows ?? [] { rows[key] = nil }
    for row in message.rows ?? [] { rows[row.key] = row }
    if let order = message.order {
      self.order = order
    } else {
      // A row that is new or gone without a new order keeps the others where they were.
      order = order.filter { rows[$0] != nil }
      for row in message.rows ?? [] where !order.contains(row.key) { order.append(row.key) }
    }
    for key in message.removedRequests ?? [] { requests[key] = nil }
    for request in message.requests ?? [] { requests[request.key] = request }
    if let requestOrder = message.requestOrder {
      self.requestOrder = requestOrder
    } else {
      requestOrder = requestOrder.filter { requests[$0] != nil }
      for request in message.requests ?? [] where !requestOrder.contains(request.key) {
        requestOrder.append(request.key)
      }
    }
    if let notices = message.notices { self.notices = notices }
    if let summary = message.summary { self.summary = summary }
    return .applied
  }

  func text(_ key: String, _ values: [String: String] = [:]) -> String {
    var text = strings[key] ?? key
    for (name, value) in values { text = text.replacingOccurrences(of: "{{\(name)}}", with: value) }
    return text
  }

  /// A row's status as the island shows it: a call with no result past the limit is stuck.
  func status(of row: IslandRow, now: Date = Date()) -> String {
    if row.status == "running", let since = row.toolSince,
      now.timeIntervalSince1970 * 1000 - since > stuckAfterMs
    {
      return "stuck"
    }
    return row.status
  }
}
