import Foundation

/// The protocol version this helper speaks; main's hello names its own.
let islandProtocol = 4

/// The longest line either side sends, in bytes, the newline excluded.
let maxLineBytes = 1024 * 1024

struct IslandHost: Codable, Equatable {
  let id: String
  let name: String
  let offline: Bool
}

struct IslandParent: Codable, Equatable {
  let kind: String
  let title: String?
}

struct IslandAgent: Codable, Equatable {
  let id: String
  let name: String
  let harness: String
  let color: String?
}

struct IslandPlan: Codable, Equatable {
  let done: Int
  let total: Int
  /// The step it is on, from 1, as the session's plan chip counts it.
  let step: Int
  let current: String?
}

struct IslandSubagents: Codable, Equatable {
  let running: Int
  let text: String
}

struct IslandLimit: Codable, Equatable {
  let label: String
  let resetsAt: Double?
}

struct IslandCache: Codable, Equatable {
  let expiresAt: Double
  /// How long before it expires the island marks it as ending.
  let endingMs: Double
  let estimate: Bool
}

struct IslandRow: Codable, Equatable {
  let key: String
  let sessionId: String
  let host: IslandHost?
  let parent: IslandParent?
  let title: String
  let project: String
  let agent: IslandAgent
  let model: String?
  let group: String
  let status: String
  let since: Double?
  let line: String
  let toolSince: Double?
  let toolKind: String?
  let turnStartedAt: Double?
  let plan: IslandPlan?
  let subagents: IslandSubagents?
  let limit: IslandLimit?
  let phase: String?
  let cache: IslandCache?
}

struct IslandOption: Codable, Equatable {
  let id: String
  let label: String
  let style: String
}

struct IslandTaskRef: Codable, Equatable {
  let title: String
  let step: String?
}

struct IslandRequest: Codable, Equatable {
  let key: String
  /// Its session's row; nil for a task's.
  let row: String?
  let task: IslandTaskRef?
  let kind: String
  let title: String
  let lines: [String]
  let code: Bool
  let options: [IslandOption]
  let askedAt: Double?
}

/// An agent's mark: its harness's, with an added agent's color dot.
struct IslandMark: Codable, Equatable {
  let harness: String
  let color: String?
}

struct IslandMeter: Codable, Equatable {
  let percent: Double
  let reached: Bool
  let text: String
}

/// One line under the sessions about Kettu itself: its update, the agents' updates, a plan limit.
struct IslandNotice: Codable, Equatable {
  let key: String
  let kind: String
  /// Empty for Kettu's own, which leads with the fox.
  let marks: [IslandMark]
  let title: String
  let detail: String?
  let meter: IslandMeter?
  let trailing: String?
  /// A button that acts in place; nil when a click opens Kettu instead.
  let button: String?
  let link: String?
}

struct IslandSummary: Codable, Equatable {
  let running: Int
  let waiting: Int
  let failed: Int
  let today: Int?
}

/// What main sends. Fields a message type does not carry are nil.
struct MainMessage: Decodable {
  let type: String
  // hello
  let protocolVersion: Int?
  let version: String?
  let locale: String?
  let strings: [String: String]?
  let colorMode: String?
  let stuckAfterMs: Double?
  // view and change
  let seq: Int?
  let rows: [IslandRow]?
  let requests: [IslandRequest]?
  let notices: [IslandNotice]?
  let summary: IslandSummary?
  let removedRows: [String]?
  let order: [String]?
  let removedRequests: [String]?
  let requestOrder: [String]?
  // pop
  let row: String?
  let kind: String?
  let title: String?
  let body: String?
  let mark: IslandMark?
  let percent: Double?
  let action: String?
  // answered
  let id: String?
  let result: String?
  let message: String?

  enum CodingKeys: String, CodingKey {
    case type, version, locale, strings, colorMode, stuckAfterMs, seq, rows, requests, summary
    case removedRows, order, removedRequests, requestOrder, row, kind, title, body, id, result
    case message, notices, mark, percent, action
    case protocolVersion = "protocol"
  }
}

/// What the helper sends: only what the user did, which main checks before acting on it.
enum HelperMessage {
  case ready
  case answer(id: String, request: String, option: String)
  case open(row: String?)
  /// What a request belongs to, its session or its task, to answer it in Kettu.
  case openRequest(String)
  /// A notice's button or row, or a pop's action.
  case notice(String)
  case newSession
  case expanded
  case resync

  var json: [String: Any] {
    switch self {
    case .ready:
      return ["type": "ready", "protocol": islandProtocol, "version": helperVersion]
    case .answer(let id, let request, let option):
      return ["type": "answer", "id": id, "request": request, "option": option]
    case .open(let row):
      return ["type": "open", "row": row as Any? ?? NSNull()]
    case .openRequest(let request):
      return ["type": "openRequest", "request": request]
    case .notice(let notice):
      return ["type": "notice", "notice": notice]
    case .newSession:
      return ["type": "newSession"]
    case .expanded:
      return ["type": "expanded"]
    case .resync:
      return ["type": "resync"]
    }
  }
}

let helperVersion = "0.1.0"
