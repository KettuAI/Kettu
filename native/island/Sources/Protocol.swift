import Foundation

/// The protocol version this helper speaks; main's hello names its own.
let islandProtocol = 1

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
}

struct IslandOption: Codable, Equatable {
  let id: String
  let label: String
  let style: String
}

struct IslandRequest: Codable, Equatable {
  let key: String
  let row: String
  let kind: String
  let title: String
  let lines: [String]
  let code: Bool
  let options: [IslandOption]
  let askedAt: Double?
}

struct SummaryLimit: Codable, Equatable {
  let agent: String
  let label: String
  let usedPercent: Double?
  let reached: Bool
  let resetsAt: Double?
}

struct IslandWindow: Codable, Equatable {
  let label: String
  let usedPercent: Double
  let resetsAt: Double?
  let level: String
}

struct IslandLimits: Codable, Equatable {
  let agent: IslandLimitAgent
  let windows: [IslandWindow]
}

struct IslandLimitAgent: Codable, Equatable {
  let name: String
  let harness: String
  let color: String?
}

struct IslandSummary: Codable, Equatable {
  let running: Int
  let waiting: Int
  let failed: Int
  let limit: SummaryLimit?
  let limits: [IslandLimits]?
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
  // answered
  let id: String?
  let result: String?
  let message: String?

  enum CodingKeys: String, CodingKey {
    case type, version, locale, strings, colorMode, stuckAfterMs, seq, rows, requests, summary
    case removedRows, order, removedRequests, requestOrder, row, kind, title, body, id, result
    case message
    case protocolVersion = "protocol"
  }
}

/// What the helper sends: only what the user did, which main checks before acting on it.
enum HelperMessage {
  case ready
  case answer(id: String, request: String, option: String)
  case open(row: String?)
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
    case .expanded:
      return ["type": "expanded"]
    case .resync:
      return ["type": "resync"]
    }
  }
}

let helperVersion = "0.1.0"
