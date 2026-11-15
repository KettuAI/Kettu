import { StarIcon } from '@hugeicons/core-free-icons'
import { toast } from '@renderer/components/ui/toast'
import { i18n } from '@renderer/lib/i18n'
import { starKettu } from '@renderer/stores/github-star'

/** The palette closes at once, so a toast confirms the star once gh has answered. */
export function starFromPalette(): void {
  void starKettu().then((starred) => {
    if (starred) toast(i18n.t('star:toast'), undefined, { icon: StarIcon })
  })
}
