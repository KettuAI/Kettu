import type { IconSvgElement } from '@hugeicons/react'
import {
  AiBrain01Icon,
  Bookmark01Icon,
  BookOpen01Icon,
  Briefcase01Icon,
  Bug01Icon,
  BulbIcon,
  Camera01Icon,
  ChartLineData01Icon,
  CloudIcon,
  CodeIcon,
  Coffee01Icon,
  CompassIcon,
  ComputerTerminal01Icon,
  CpuIcon,
  CubeIcon,
  DatabaseIcon,
  FavouriteIcon,
  File01Icon,
  FireIcon,
  FlashIcon,
  Folder01Icon,
  GameController01Icon,
  GitBranchIcon,
  Globe02Icon,
  Home01Icon,
  LabsIcon,
  LaptopIcon,
  Layers01Icon,
  LockIcon,
  MusicNote01Icon,
  NotebookIcon,
  PackageIcon,
  PaintBoardIcon,
  RoboticIcon,
  Rocket01Icon,
  ServerStack01Icon,
  Settings01Icon,
  Shield01Icon,
  SmartPhone01Icon,
  SparklesIcon,
  StarIcon,
  Wrench01Icon,
} from '@hugeicons/core-free-icons'
import {
  PROJECT_ICON_COLORS,
  type ProjectIconColor,
  type ProjectIconName,
} from '@shared/project-icon'

export interface ProjectIconEntry {
  name: ProjectIconName
  glyph: IconSvgElement
  /** Bilingual search terms (English and Chinese) for filtering in the icon picker. */
  keywords: readonly string[]
}

export const PROJECT_ICON_ENTRIES: readonly ProjectIconEntry[] = [
  {
    name: 'folder',
    glyph: Folder01Icon,
    keywords: ['folder', 'dir', 'directory', '文件夹', '目录'],
  },
  {
    name: 'code',
    glyph: CodeIcon,
    keywords: ['code', 'dev', 'source', 'programming', '代码', '开发'],
  },
  {
    name: 'terminal',
    glyph: ComputerTerminal01Icon,
    keywords: ['terminal', 'cli', 'shell', 'console', 'backend', '终端', '命令行', '后端'],
  },
  {
    name: 'git-branch',
    glyph: GitBranchIcon,
    keywords: ['git', 'branch', 'repo', 'version', '分支', '仓库'],
  },
  {
    name: 'bug',
    glyph: Bug01Icon,
    keywords: ['bug', 'debug', 'fix', 'test', '调试', '测试', '修复'],
  },
  {
    name: 'wrench',
    glyph: Wrench01Icon,
    keywords: ['wrench', 'tool', 'tools', 'build', 'utils', '工具', '构建'],
  },
  {
    name: 'settings',
    glyph: Settings01Icon,
    keywords: ['settings', 'config', 'gear', 'ops', '设置', '配置', '运维'],
  },
  {
    name: 'globe',
    glyph: Globe02Icon,
    keywords: ['globe', 'web', 'frontend', 'site', 'network', '网页', '前端', '网站', '地球'],
  },
  {
    name: 'server',
    glyph: ServerStack01Icon,
    keywords: ['server', 'api', 'infra', 'service', 'backend', '服务器', '服务', '接口'],
  },
  {
    name: 'database',
    glyph: DatabaseIcon,
    keywords: ['database', 'db', 'sql', 'storage', 'data', '数据库', '存储', '数据'],
  },
  {
    name: 'cloud',
    glyph: CloudIcon,
    keywords: ['cloud', 'deploy', 'sync', 'saas', '云', '云端', '部署'],
  },
  {
    name: 'cpu',
    glyph: CpuIcon,
    keywords: ['cpu', 'chip', 'hardware', 'kernel', 'system', '芯片', '硬件', '系统', '内核'],
  },
  {
    name: 'smartphone',
    glyph: SmartPhone01Icon,
    keywords: ['smartphone', 'mobile', 'phone', 'ios', 'android', 'app', '手机', '移动', '客户端'],
  },
  {
    name: 'laptop',
    glyph: LaptopIcon,
    keywords: ['laptop', 'desktop', 'computer', 'mac', 'client', '桌面', '电脑', '客户端'],
  },
  {
    name: 'sparkles',
    glyph: SparklesIcon,
    keywords: ['sparkles', 'ai', 'llm', 'magic', 'agent', '智能', '灵感', '星光'],
  },
  {
    name: 'brain',
    glyph: AiBrain01Icon,
    keywords: ['brain', 'ai', 'ml', 'model', 'research', '大脑', '人工智能', '模型', '研究'],
  },
  {
    name: 'robot',
    glyph: RoboticIcon,
    keywords: ['robot', 'bot', 'agent', 'automation', '机器人', '自动化', '智能体'],
  },
  {
    name: 'flask',
    glyph: LabsIcon,
    keywords: ['flask', 'lab', 'labs', 'experiment', 'demo', 'prototype', '实验', '试验', '原型'],
  },
  {
    name: 'rocket',
    glyph: Rocket01Icon,
    keywords: ['rocket', 'launch', 'ship', 'startup', 'release', '火箭', '发布', '启动'],
  },
  {
    name: 'bolt',
    glyph: FlashIcon,
    keywords: ['bolt', 'flash', 'fast', 'speed', 'performance', '闪电', '性能', '加速'],
  },
  {
    name: 'palette',
    glyph: PaintBoardIcon,
    keywords: [
      'palette',
      'design',
      'ui',
      'art',
      'theme',
      'color',
      '设计',
      '调色板',
      '画板',
      '主题',
    ],
  },
  {
    name: 'layers',
    glyph: Layers01Icon,
    keywords: ['layers', 'stack', 'architecture', 'design', '图层', '架构', '栈'],
  },
  {
    name: 'cube',
    glyph: CubeIcon,
    keywords: ['cube', 'module', 'sdk', '3d', 'block', '模块', '组件', '立方体'],
  },
  {
    name: 'package',
    glyph: PackageIcon,
    keywords: ['package', 'box', 'library', 'npm', 'release', '包', '依赖', '组件库'],
  },
  {
    name: 'file',
    glyph: File01Icon,
    keywords: ['file', 'doc', 'document', 'text', '文件', '文档'],
  },
  {
    name: 'book',
    glyph: BookOpen01Icon,
    keywords: ['book', 'docs', 'wiki', 'guide', 'manual', '书', '书本', '文档库', '知识库'],
  },
  {
    name: 'notebook',
    glyph: NotebookIcon,
    keywords: ['notebook', 'note', 'notes', 'journal', 'memo', '笔记', '备忘'],
  },
  {
    name: 'briefcase',
    glyph: Briefcase01Icon,
    keywords: [
      'briefcase',
      'work',
      'business',
      'client',
      'company',
      '工作',
      '商务',
      '公司',
      '客户',
    ],
  },
  {
    name: 'chart',
    glyph: ChartLineData01Icon,
    keywords: [
      'chart',
      'analytics',
      'metrics',
      'finance',
      'report',
      '图表',
      '分析',
      '指标',
      '报表',
    ],
  },
  {
    name: 'shield',
    glyph: Shield01Icon,
    keywords: ['shield', 'security', 'auth', 'guard', 'safe', '安全', '盾牌', '防护'],
  },
  {
    name: 'lock',
    glyph: LockIcon,
    keywords: ['lock', 'private', 'secret', 'vault', 'crypto', '锁', '加密', '私密'],
  },
  {
    name: 'compass',
    glyph: CompassIcon,
    keywords: ['compass', 'explore', 'roadmap', 'navigation', '指南针', '探索', '路线图'],
  },
  {
    name: 'home',
    glyph: Home01Icon,
    keywords: ['home', 'personal', 'local', 'main', '首页', '个人', '主项目'],
  },
  {
    name: 'star',
    glyph: StarIcon,
    keywords: ['star', 'favorite', 'important', 'featured', '星标', '收藏', '重要'],
  },
  {
    name: 'heart',
    glyph: FavouriteIcon,
    keywords: ['heart', 'love', 'hobby', 'life', '心', '喜欢', '生活', '爱好'],
  },
  {
    name: 'flame',
    glyph: FireIcon,
    keywords: ['flame', 'fire', 'hot', 'urgent', 'prod', '火焰', '热门', '紧急', '核心'],
  },
  {
    name: 'bulb',
    glyph: BulbIcon,
    keywords: ['bulb', 'idea', 'brainstorm', 'draft', '灯泡', '想法', '创意'],
  },
  {
    name: 'coffee',
    glyph: Coffee01Icon,
    keywords: ['coffee', 'side', 'casual', 'daily', '咖啡', '日常', '副业'],
  },
  {
    name: 'gamepad',
    glyph: GameController01Icon,
    keywords: ['gamepad', 'game', 'play', 'fun', '游戏', '手柄', '娱乐'],
  },
  {
    name: 'music',
    glyph: MusicNote01Icon,
    keywords: ['music', 'audio', 'sound', 'media', '音乐', '音频', '声音'],
  },
  {
    name: 'camera',
    glyph: Camera01Icon,
    keywords: ['camera', 'photo', 'video', 'media', 'image', '相机', '影像', '图片', '视频'],
  },
  {
    name: 'bookmark',
    glyph: Bookmark01Icon,
    keywords: ['bookmark', 'reading', 'reference', 'archive', '书签', '参考', '归档'],
  },
]

export const PROJECT_ICON_GLYPHS: Record<ProjectIconName, IconSvgElement> = Object.fromEntries(
  PROJECT_ICON_ENTRIES.map((entry) => [entry.name, entry.glyph]),
) as Record<ProjectIconName, IconSvgElement>

/** CSS custom property reference for a preset project icon color token. */
export function projectIconColorVar(color: ProjectIconColor): string {
  return `var(--project-icon-${color})`
}

export interface ProjectColorSwatch {
  color: ProjectIconColor | null
  cssVar: string | null
}

export const PROJECT_COLOR_SWATCHES: readonly ProjectColorSwatch[] = [
  { color: null, cssVar: null },
  ...PROJECT_ICON_COLORS.map((color) => ({
    color,
    cssVar: projectIconColorVar(color),
  })),
]

export const CURATED_PROJECT_EMOJIS: readonly string[] = [
  '🚀',
  '💻',
  '⚡',
  '🛠️',
  '🐛',
  '🧪',
  '🌐',
  '📡',
  '🗄️',
  '☁️',
  '🤖',
  '🧠',
  '✨',
  '🎨',
  '📦',
  '📱',
  '🖥️',
  '🔒',
  '🛡️',
  '📚',
  '📝',
  '📊',
  '📈',
  '💼',
  '🧭',
  '🎯',
  '🔥',
  '💡',
  '⭐',
  '❤️',
  '🌱',
  '🌿',
  '🦊',
  '🐱',
  '🐙',
  '🐳',
  '🦀',
  '🐍',
  '💎',
  '🔮',
  '🎵',
  '📷',
  '🎮',
  '☕',
  '🏠',
  '🌍',
  '🏁',
  '📌',
]

/** Filters built-in project icons by English/Chinese keywords or canonical icon name. */
export function filterProjectIcons(query: string): readonly ProjectIconEntry[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return PROJECT_ICON_ENTRIES
  const terms = needle.split(/\s+/).filter(Boolean)
  return PROJECT_ICON_ENTRIES.filter((entry) =>
    terms.every(
      (term) =>
        entry.name.includes(term) ||
        entry.keywords.some((keyword) => keyword.toLowerCase().includes(term)),
    ),
  )
}
