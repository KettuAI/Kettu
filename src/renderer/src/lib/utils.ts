import { createCn } from 'cn/engine'
import tables from './cn-tables'

// The default tables only know Tailwind's own scales, so they read theme tokens like text-ui as
// colors. These are compiled from the @theme in globals.css by the cn plugin.
export const cn = createCn(tables)
