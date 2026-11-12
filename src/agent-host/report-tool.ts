// The problem report tool of the artifacts service: an agent drafts a report about Kettu itself,
// which the host adds to the calling session's thread for the user to send. The tool sends nothing.

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { longer } from '@shared/artifacts'
import { REPORT_DESCRIPTION_MAX, REPORT_ERROR_MAX } from '@shared/report'
import type { Caller } from './artifacts/tools'

export const REPORT_TOOL = 'report_problem'
export const TITLE_CHARS = 120
/** The title and details become one description, a blank line between them. */
export const DETAILS_CHARS = REPORT_DESCRIPTION_MAX - TITLE_CHARS - 2
export const ERROR_CHARS = REPORT_ERROR_MAX
export const REPORTS_PER_DAY = 3

const REPORT_GUIDANCE =
  'Only for problems with Kettu itself: a Kettu tool failing or returning something wrong, an ' +
  'error of the Kettu app or host, or the user saying something in Kettu is wrong or asking you ' +
  "to report it. Never for bugs in the user's project, outages or limits of your model " +
  "provider, or your own mistakes. Write in the user's language so they can read what is sent. " +
  'Leave out secrets, and quote only the lines of code or conversation the report needs. ' +
  'The report waits in the thread for the user to send it; nothing is sent by this call.'

export const REPORT_INSTRUCTIONS = `${REPORT_TOOL} drafts a problem report for the Kettu team. ${REPORT_GUIDANCE}`

export const REPORT_TOOLS: Tool[] = [
  {
    name: REPORT_TOOL,
    title: 'Report a problem with Kettu',
    description: `Drafts a problem report for the Kettu team, which the user reviews and sends. ${REPORT_GUIDANCE}`,
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          minLength: 1,
          maxLength: TITLE_CHARS,
          description: 'One line that names the problem.',
        },
        details: {
          type: 'string',
          minLength: 1,
          maxLength: DETAILS_CHARS,
          description:
            'What you were doing, what you expected, what happened instead, and how to reproduce it.',
        },
        error: {
          type: 'string',
          maxLength: ERROR_CHARS,
          description: 'The error text as Kettu returned it, if there was one.',
        },
      },
      required: ['title', 'details'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
]

export function isReportToolName(name: string): boolean {
  return name === REPORT_TOOL
}

/** A report as the agent drafted it, checked. */
export interface ReportDraft {
  title: string
  details: string
  error: string | null
}

export interface ReportToolsDeps {
  /**
   * Adds the draft to the session's thread. `none` for a session Kettu holds no thread for, `open`
   * while an earlier draft still waits, `daily` once the day's drafts are used up.
   */
  add(sessionId: string, draft: ReportDraft): 'added' | 'none' | 'open' | 'daily'
}

type ReportToolErrorCode = 'invalid' | 'not_found' | 'limited'

export class ReportToolError extends Error {
  constructor(
    readonly code: ReportToolErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ReportToolError'
  }
}

function invalid(message: string): ReportToolError {
  return new ReportToolError('invalid', message)
}

function text(
  fields: Record<string, unknown>,
  key: string,
  max: number,
  required: boolean,
): string | null {
  const value = fields[key]
  if (value === undefined && !required) return null
  if (typeof value !== 'string') throw invalid(`${key} must be a string.`)
  const trimmed = value.trim()
  if (trimmed === '') {
    if (required) throw invalid(`${key} must not be empty.`)
    return null
  }
  if (longer(trimmed, max)) throw invalid(`${key} must be at most ${max} characters.`)
  return trimmed
}

/** The draft a call carries, checked as the schema says; the title is cut to one line. */
export function parseDraft(input: unknown): ReportDraft {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalid('The arguments must be an object with a title and details.')
  }
  const fields = input as Record<string, unknown>
  const unknown = Object.keys(fields).find(
    (key) => key !== 'title' && key !== 'details' && key !== 'error',
  )
  if (unknown !== undefined) throw invalid(`Unknown argument ${unknown}.`)
  const title = text(fields, 'title', TITLE_CHARS, true)!.replace(/\s+/g, ' ')
  const details = text(fields, 'details', DETAILS_CHARS, true)!
  const error = text(fields, 'error', ERROR_CHARS, false)
  return { title, details, error }
}

export class ReportTools {
  constructor(private readonly deps: ReportToolsDeps) {}

  /** Serves a call; a refusal becomes a tool error whose text says why. */
  call(caller: Caller, name: string, input: unknown): CallToolResult {
    if (name !== REPORT_TOOL) throw new Error(`Unknown tool ${name}`)
    try {
      const added = this.deps.add(caller.sessionId, parseDraft(input))
      if (added === 'none') {
        throw new ReportToolError('not_found', 'This session is not open, so it shows no report.')
      }
      if (added === 'open') {
        throw new ReportToolError(
          'limited',
          'An earlier report of this session still waits for the user. Do not draft another one.',
        )
      }
      if (added === 'daily') {
        throw new ReportToolError(
          'limited',
          `This session already drafted ${REPORTS_PER_DAY} reports today. Try again tomorrow.`,
        )
      }
      return {
        content: [
          {
            type: 'text',
            text:
              'The report waits in the thread for the user to review and send. Nothing has been ' +
              'sent. Do not call this again for the same problem; carry on with your task.',
          },
        ],
      }
    } catch (error) {
      if (!(error instanceof ReportToolError)) throw error
      return {
        content: [{ type: 'text', text: error.message }],
        structuredContent: { code: error.code, message: error.message },
        isError: true,
      }
    }
  }
}
