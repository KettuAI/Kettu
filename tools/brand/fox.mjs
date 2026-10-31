// The Kettu icon: an orange fox's head on a rounded tile, as one SVG template. Its coordinates are
// those of the 974 px tile the approved artwork was traced on; each framing scales them.

const TILE = { x: 136.5, y: 139.75, size: 974 }
const CANVAS = 1024
// The shipped tile is 960 px on the 1024 px canvas.
const TILE_INSET = 32
// The fox is drawn about x = 620; this centres it on the tile.
const FOX_DX = 3.5
// Continuous corners: each side leaves the corner 221 px away, with 122 px handles.
const CORNER = { length: 221, handle: 122 }

const DEFS = `
  <clipPath id="badgeClip"><use xlink:href="#badge"/></clipPath>
  <linearGradient id="baseGrad" x1="248" y1="904" x2="1015" y2="199" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#FE7821"/><stop offset=".40" stop-color="#FA5615"/><stop offset=".73" stop-color="#FF4315"/><stop offset="1" stop-color="#D91F0A"/>
  </linearGradient>
  <radialGradient id="baseGlow" cx="280" cy="578" r="746" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#FF9D39" stop-opacity=".8"/><stop offset=".5" stop-color="#FF6120" stop-opacity=".06"/><stop offset="1" stop-color="#CD2100" stop-opacity=".10"/>
  </radialGradient>
  <linearGradient id="topSheet" x1="230" y1="160" x2="670" y2="376" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#FFC364"/><stop offset=".38" stop-color="#FF9E34"/><stop offset=".77" stop-color="#F75A10"/><stop offset="1" stop-color="#F04C0E"/>
  </linearGradient>
  <linearGradient id="midSheet" x1="252" y1="280" x2="1030" y2="690" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#FFAA48"/><stop offset=".27" stop-color="#FF8A26"/><stop offset=".64" stop-color="#FF6919"/><stop offset="1" stop-color="#FF9035"/>
  </linearGradient>
  <linearGradient id="midCenterGlow" x1="207" y1="525" x2="880" y2="880" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#FF7520"/><stop offset=".52" stop-color="#D93A08"/><stop offset="1" stop-color="#D83703"/>
  </linearGradient>
  <linearGradient id="lowerRibbon" x1="200" y1="950" x2="1030" y2="910" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#FF8121"/><stop offset=".23" stop-color="#FF9D2E"/><stop offset=".46" stop-color="#FD7522"/><stop offset=".74" stop-color="#F5480F"/><stop offset="1" stop-color="#FF7030"/>
  </linearGradient>
  <radialGradient id="lowerGlow" cx="1040" cy="709" r="383" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#FFE19F" stop-opacity=".95"/><stop offset=".4" stop-color="#FFB466" stop-opacity=".5"/><stop offset="1" stop-color="#FF7026" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="edgeLight" x1="160" y1="160" x2="1033" y2="1091" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#FFF1B9" stop-opacity=".68"/><stop offset=".25" stop-color="#FFFFFF" stop-opacity=".07"/><stop offset=".57" stop-color="#FFEA9A" stop-opacity="0"/><stop offset="1" stop-color="#FFF1D8" stop-opacity=".44"/>
  </linearGradient>
  <linearGradient id="valleyGrad" x1="450" y1="0" x2="1111" y2="0" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#A80C00" stop-opacity="0"/><stop offset=".3" stop-color="#A80C00" stop-opacity="0.6"/><stop offset=".75" stop-color="#A80C00" stop-opacity="0.6"/><stop offset="1" stop-color="#A80C00" stop-opacity="0.21"/>
  </linearGradient>
  <filter id="valleyBlur" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="16"/></filter>
  <filter id="foxHalo" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceAlpha" stdDeviation="50"/><feOffset dx="0" dy="0" result="s"/><feFlood flood-color="#E00800" flood-opacity="0.7"/><feComposite in2="s" operator="in"/></filter>
  <filter id="foxAmbient" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceAlpha" stdDeviation="24"/><feOffset dx="0" dy="4" result="s"/><feFlood flood-color="#D00800" flood-opacity="0.75"/><feComposite in2="s" operator="in"/></filter>
  <filter id="foxCast" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceAlpha" stdDeviation="26"/><feOffset dx="18" dy="22" result="s"/><feFlood flood-color="#B80600" flood-opacity="0.75"/><feComposite in2="s" operator="in"/></filter>
  <filter id="foxContact" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceAlpha" stdDeviation="8"/><feOffset dx="0" dy="14" result="s"/><feFlood flood-color="#980400" flood-opacity="0.85"/><feComposite in2="s" operator="in"/></filter>
  <filter id="recessBlur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="5"/></filter>
  <filter id="softWave" x="-15%" y="-15%" width="130%" height="140%"><feGaussianBlur stdDeviation="6"/></filter>
`

// What the fox itself is drawn with, which the glyph carries without the rest.
const FOX_DEFS = `
  <!-- Light comes from the upper left, so the right-hand parts keep their own, slightly darker stops. -->
  <linearGradient id="earBase" x1="307" y1="336" x2="539" y2="536" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#FFFDF2"/><stop offset=".2" stop-color="#FFE8BD"/><stop offset=".47" stop-color="#FFBD6C"/><stop offset=".75" stop-color="#FF8E24"/><stop offset="1" stop-color="#F45F12"/>
  </linearGradient>
  <linearGradient id="earInner" x1="326" y1="360" x2="429" y2="606" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#FFFFF0"/><stop offset=".39" stop-color="#FFE4C1"/><stop offset=".72" stop-color="#FFC29C"/><stop offset="1" stop-color="#F7854C"/>
  </linearGradient>
  <linearGradient id="earBaseR" x1="921" y1="338" x2="711" y2="531" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#FFF9E3"/><stop offset=".2" stop-color="#FFDFAC"/><stop offset=".53" stop-color="#FFAD54"/><stop offset=".75" stop-color="#FF761D"/><stop offset="1" stop-color="#E84E12"/>
  </linearGradient>
  <linearGradient id="earInnerR" x1="915" y1="346" x2="824" y2="616" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#FFFDF1"/><stop offset=".35" stop-color="#FFE5C9"/><stop offset=".7" stop-color="#FFC7AA"/><stop offset="1" stop-color="#F27B4A"/>
  </linearGradient>
  <radialGradient id="faceFront" cx="640" cy="715" r="260" gradientUnits="userSpaceOnUse" gradientTransform="translate(640 715) scale(1.25 1) translate(-640 -715)">
    <stop offset="0" stop-color="#FD5011"/><stop offset=".1" stop-color="#FD5412"/><stop offset=".23" stop-color="#FC5C11"/><stop offset=".37" stop-color="#FD6B16"/><stop offset=".52" stop-color="#FE7E1F"/><stop offset=".6" stop-color="#FE8D28"/><stop offset=".68" stop-color="#FC9C31"/><stop offset=".75" stop-color="#FCAE44"/><stop offset=".83" stop-color="#FDC868"/><stop offset=".9" stop-color="#FFD788"/><stop offset="1" stop-color="#FFE0A0"/>
  </radialGradient>
  <linearGradient id="wedgeFade" x1="620" y1="770" x2="620" y2="915" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#FF7A2E" stop-opacity="0"/><stop offset=".35" stop-color="#FD8F48" stop-opacity=".6"/><stop offset=".69" stop-color="#FDBC86" stop-opacity=".92"/><stop offset=".93" stop-color="#FDE4C6"/><stop offset="1" stop-color="#FEEDDC"/>
  </linearGradient>
  <linearGradient id="cheek" x1="364" y1="622" x2="607" y2="926" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#FFFCED"/><stop offset=".25" stop-color="#FFF1D9"/><stop offset=".53" stop-color="#FFDEC2"/><stop offset=".72" stop-color="#FFD0AD"/><stop offset=".92" stop-color="#FFF1DA"/><stop offset="1" stop-color="#FFF9EF"/>
  </linearGradient>
  <linearGradient id="cheekR" x1="871" y1="620" x2="633" y2="926" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#FFF9EB"/><stop offset=".28" stop-color="#FFEAD4"/><stop offset=".57" stop-color="#FFD7BC"/><stop offset=".77" stop-color="#FFD1B2"/><stop offset=".94" stop-color="#FFF0DF"/><stop offset="1" stop-color="#FFFCF1"/>
  </linearGradient>
  <linearGradient id="cheekShine" x1="356" y1="600" x2="577" y2="883" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#FFFFFF" stop-opacity=".75"/><stop offset=".33" stop-color="#FFFFFF" stop-opacity=".10"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="cheekShineR" x1="883" y1="597" x2="658" y2="879" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#FFFFFF" stop-opacity=".74"/><stop offset=".37" stop-color="#FFFFFF" stop-opacity=".14"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="domeEdgeLight" x1="360" y1="0" x2="880" y2="0" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#FFF2C8" stop-opacity=".75"/><stop offset=".5" stop-color="#FFF2C8" stop-opacity=".45"/><stop offset="1" stop-color="#FFF2C8" stop-opacity=".08"/>
  </linearGradient>
  <filter id="earOccl" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceAlpha" stdDeviation="20"/><feOffset dx="0" dy="0" result="s"/><feFlood flood-color="#E01000" flood-opacity="0.8"/><feComposite in2="s" operator="in"/></filter>
  <filter id="sharpGlow" x="-20%" y="-30%" width="140%" height="160%"><feGaussianBlur stdDeviation="2.3"/></filter>
  <filter id="hairGlow" x="-20%" y="-30%" width="140%" height="160%"><feGaussianBlur stdDeviation="1.1"/></filter>
`

const BACKGROUND = `
  <use xlink:href="#badge" fill="url(#baseGrad)"/>
  <use xlink:href="#badge" fill="url(#baseGlow)"/>
  <path id="upper-fold" d="M 130 381 C 163 233 242 165 336 158 C 438 145 560 239 684 354 C 523 284 426 260 378 268 C 284 271 205 302 130 385 Z" fill="url(#topSheet)"/>
  <path d="M 138 380 C 159 268 211 198 295 171 C 341 152 389 156 437 175" fill="none" stroke="#FFEB9E" stroke-width="5" opacity=".75" filter="url(#sharpGlow)"/>
  <path d="M 138 380 C 154 282 214 196 296 170 C 352 149 396 162 442 179" fill="none" stroke="#FFCF79" stroke-width="2.5" opacity=".72"/>
  <!-- Shadow in the fold above the ribbon, deepest behind the ears; the ribbon covers its lower half. -->
  <path id="ribbon-valley" d="M 137 380 C 215 289 299 263 373 266 C 494.9 258.8 647.4 320.5 757 409 C 862.7 494.4 972.1 583.8 1111 638" fill="none" stroke="url(#valleyGrad)" stroke-width="34" filter="url(#valleyBlur)"/>
  <path id="mid-ribbon" d="M 137 380 C 215 289 299 263 373 266 C 494.9 258.8 647.4 320.5 757 409 C 862.7 494.4 972.1 583.8 1111 638 L 1111 786 C 969 711 868 715 768 793 C 630 902 505 1019 362 992 C 254 990 177 931 136 868 Z" fill="url(#midSheet)"/>
  <path d="M 137 380 C 215 289 299 263 373 266 C 494.9 258.8 647.4 320.5 757 409" fill="none" stroke="#FFF4C8" stroke-width="3.5" opacity=".55" filter="url(#sharpGlow)"/>
  <path d="M 137 380 C 215 289 299 263 373 266 C 494.9 258.8 647.4 320.5 757 409" fill="none" stroke="#FFE2A1" stroke-width="1.5" opacity=".48"/>
  <path id="recessed-crescent" d="M 360 380 C 276 483 214 591 220 716 C 218 831 282 915 370 965 C 458 1024 570 971 679 872 C 773 779 851 679 976 703 C 835 578 644 454 481 393 Z" fill="url(#midCenterGlow)" opacity="0.8" filter="url(#recessBlur)"/>
  <path id="lower-ribbon" d="M 136 867 C 208 961 320 975 399 968 C 526 961 606 902 707 807 C 838 692 967 699 1113 710 L 1113 1120 L 135 1120 Z" fill="url(#lowerRibbon)"/>
  <path d="M 137 866 C 209 957 321 971 400 968 C 528 960 611 893 708 804 C 829 709 967 697 1110 712" fill="none" stroke="#FFD88A" opacity=".48" stroke-width="9" filter="url(#softWave)"/>
  <path d="M 137 867 C 208 959 318 974 399 969 C 530 961 613 898 708 806 C 839 701 969 700 1110 711" fill="none" stroke="#FFDA87" stroke-width="2.1" opacity=".77"/>
  <path id="lower-sheet-glow" d="M 451 1114 C 564 1094 649 1014 713 917 C 821 759 916 719 1110 711 L 1110 1114 Z" fill="url(#lowerGlow)"/>
`

const EDGE_LIGHT =
  '<use xlink:href="#badge" fill="none" stroke="url(#edgeLight)" stroke-width="6" opacity=".58" clip-path="url(#badgeClip)"/>'

// The outlines of the fox's parts; the glyph is sized to their bounds.
const SHAPES = {
  'ear-left':
    'M 328 324.5 C 353 323.5 493.8 388.3 559.5 494.5 C 526 560.5 425 635.5 350.5 638.5 C 311.5 583.8 292.6 489.2 300 408 C 307.2 358.1 316.5 325.1 328 324.5 Z',
  'ear-right':
    'M 912 324.5 C 887 323.5 746.2 388.3 680.5 494.5 C 714 560.5 815 635.5 889.5 638.5 C 928.5 583.8 947.4 489.2 940 408 C 932.8 358.1 923.5 325.1 912 324.5 Z',
  forehead:
    'M 362 633 C 417.3 543.8 521.9 488 620 488 C 718.1 488 822.7 543.8 878 633 C 882 651 861.6 709.9 847.6 719.9 C 786.5 754.8 730.1 804.6 687.6 847.9 C 657.2 879.4 630 928 620 928 C 610 928 582.8 879.4 552.4 847.9 C 509.9 804.6 453.5 754.8 392.4 719.9 C 378.4 709.9 358 651 362 633 Z',
  'cheek-left':
    'M 360.5 624.5 C 413.1 605.5 475.4 636.9 512.5 675.5 C 589.4 755.3 595 844.1 620 922 L 624 925 L 626.9 928.8 C 622.9 929.5 623 929.5 620 929.5 C 590.6 929.5 568.5 890.1 539.5 860.5 C 497.5 817.6 443.1 769.4 383.5 735.5 C 359.9 722.1 339.5 712.3 323.5 700.5 C 306.7 688.1 309.8 670 319.5 657.5 C 330.1 643.8 345.8 629.8 360.5 624.5 Z',
  'cheek-right':
    'M 879.5 624.5 C 826.9 605.5 764.6 636.9 727.5 675.5 C 650.6 755.3 645 844.1 620 922 L 616 925 L 613.1 928.8 C 617.1 929.5 617 929.5 620 929.5 C 649.4 929.5 671.5 890.1 700.5 860.5 C 742.5 817.6 796.9 769.4 856.5 735.5 C 880.1 722.1 900.5 712.3 916.5 700.5 C 933.3 688.1 930.2 670 920.5 657.5 C 909.9 643.8 894.2 629.8 879.5 624.5 Z',
}

const FOX_SHADOW = `
  <g id="fox-shadow">
    <g filter="url(#foxHalo)"><use xlink:href="#ear-left"/><use xlink:href="#ear-right"/><use xlink:href="#forehead"/><use xlink:href="#cheek-left"/><use xlink:href="#cheek-right"/></g>
    <g filter="url(#foxAmbient)"><use xlink:href="#ear-left"/><use xlink:href="#ear-right"/><use xlink:href="#forehead"/><use xlink:href="#cheek-left"/><use xlink:href="#cheek-right"/></g>
    <g filter="url(#foxCast)"><use xlink:href="#ear-left"/><use xlink:href="#ear-right"/><use xlink:href="#forehead"/><use xlink:href="#cheek-left"/><use xlink:href="#cheek-right"/></g>
    <g filter="url(#foxContact)"><use xlink:href="#ear-left"/><use xlink:href="#ear-right"/><use xlink:href="#cheek-left"/><use xlink:href="#cheek-right"/></g>
  </g>
`

const FOX = `
  <clipPath id="earsClip"><use xlink:href="#ear-left"/><use xlink:href="#ear-right"/></clipPath>
  <g id="ears">
    <path id="ear-left" d="${SHAPES['ear-left']}" fill="url(#earBase)"/>
    <path id="ear-left-inner" d="M 328 324.5 C 382 369.5 426 446.5 454.5 540.5 C 425 580 380 617 350.5 638.5 C 311.5 583.8 292.6 489.2 300 408 C 307.2 358.1 316.5 325.1 328 324.5 Z" fill="url(#earInner)"/>
    <path id="ear-right" d="${SHAPES['ear-right']}" fill="url(#earBaseR)"/>
    <path id="ear-right-inner" d="M 912 324.5 C 858 369.5 814 446.5 785.5 540.5 C 815 580 860 617 889.5 638.5 C 928.5 583.8 947.4 489.2 940 408 C 932.8 358.1 923.5 325.1 912 324.5 Z" fill="url(#earInnerR)"/>
    <g clip-path="url(#earsClip)"><use xlink:href="#forehead" filter="url(#earOccl)"/></g>
    <path d="M 328 324.5 C 353 323.5 493.8 388.3 559.5 494.5" fill="none" stroke="#FFF8EA" stroke-width="2.5" opacity=".5" filter="url(#hairGlow)"/>
    <path d="M 912 324.5 C 887 323.5 746.2 388.3 680.5 494.5" fill="none" stroke="#FFF8EA" stroke-width="2.5" opacity=".5" filter="url(#hairGlow)"/>
  </g>
  <g id="fox-head">
    <path id="forehead" d="${SHAPES['forehead']}" fill="url(#faceFront)"/>
    <path d="M 362 633 C 417.3 543.8 521.9 488 620 488 C 718.1 488 822.7 543.8 878 633 C 882 651 861.6 709.9 847.6 719.9 C 786.5 754.8 730.1 804.6 687.6 847.9 C 657.2 879.4 630 928 620 928 C 610 928 582.8 879.4 552.4 847.9 C 509.9 804.6 453.5 754.8 392.4 719.9 C 378.4 709.9 358 651 362 633 Z" fill="url(#wedgeFade)"/>
    <path d="M 383.9 602.4 C 442.3 531.2 533.7 488 620 488 C 706.3 488 797.7 531.2 856.1 602.4" fill="none" stroke="url(#domeEdgeLight)" stroke-width="4" filter="url(#sharpGlow)"/>
  </g>
  <g id="cheeks">
    <path id="cheek-left" d="${SHAPES['cheek-left']}" fill="url(#cheek)"/>
    <path d="M 360.5 624.5 C 413.1 605.5 475.4 636.9 512.5 675.5 C 589.4 755.3 595 844.1 620 922 C 600 846 556 795 507 735 C 441 650 404 622 360.5 624.5 Z" fill="url(#cheekShine)" opacity=".28"/>
    <path id="cheek-right" d="${SHAPES['cheek-right']}" fill="url(#cheekR)"/>
    <path d="M 879.5 624.5 C 826.9 605.5 764.6 636.9 727.5 675.5 C 650.6 755.3 645 844.1 620 922 C 640 846 684 795 733 735 C 799 650 836 622 879.5 624.5 Z" fill="url(#cheekShineR)" opacity=".26"/>
    <path d="M 360.5 624.5 C 413.1 605.5 475.4 636.9 512.5 675.5" fill="none" stroke="#FFFFF4" stroke-width="2" opacity=".65" filter="url(#hairGlow)"/>
    <path d="M 879.5 624.5 C 826.9 605.5 764.6 636.9 727.5 675.5" fill="none" stroke="#FFFFF4" stroke-width="2" opacity=".65" filter="url(#hairGlow)"/>
  </g>
`

const n = (v) => String(Math.round(v * 100) / 100)

function badge(corners) {
  const { x: x0, y: y0, size } = TILE
  const x1 = x0 + size
  const y1 = y0 + size
  if (!corners) return `M ${n(x0)} ${n(y0)} H ${n(x1)} V ${n(y1)} H ${n(x0)} Z`
  const { length: l, handle: h } = CORNER
  return [
    `M ${n(x0 + l)} ${n(y0)} L ${n(x1 - l)} ${n(y0)}`,
    `C ${n(x1 - l + h)} ${n(y0)} ${n(x1)} ${n(y0 + l - h)} ${n(x1)} ${n(y0 + l)} L ${n(x1)} ${n(y1 - l)}`,
    `C ${n(x1)} ${n(y1 - l + h)} ${n(x1 - l + h)} ${n(y1)} ${n(x1 - l)} ${n(y1)} L ${n(x0 + l)} ${n(y1)}`,
    `C ${n(x0 + l - h)} ${n(y1)} ${n(x0)} ${n(y1 - l + h)} ${n(x0)} ${n(y1 - l)} L ${n(x0)} ${n(y0 + l)}`,
    `C ${n(x0)} ${n(y0 + l - h)} ${n(x0 + l - h)} ${n(y0)} ${n(x0 + l)} ${n(y0)} Z`,
  ].join(' ')
}

/**
 * The framings: `tile`, the icon as shipped, a rounded tile centred on the canvas with transparent
 * corners; `square`, the drawing filling the canvas with square corners, for places that round them
 * themselves; `background` and `fox`, the square's two layers apart.
 */
export const FRAMINGS = ['tile', 'square', 'background', 'fox']

/**
 * The icon as SVG text on a 1024 px canvas. `colors` maps the drawing's `#RRGGBB` colors to others,
 * for a colorway.
 */
export function foxSvg(framing = 'tile', { colors } = {}) {
  if (!FRAMINGS.includes(framing)) throw new Error(`Unknown framing: ${framing}`)
  const tile = framing === 'tile'
  const inset = tile ? TILE_INSET : 0
  const scale = (CANVAS - 2 * inset) / TILE.size
  const parts = [
    framing !== 'fox' ? `<g id="background" clip-path="url(#badgeClip)">${BACKGROUND}</g>` : '',
    tile ? EDGE_LIGHT : '',
    framing !== 'background'
      ? `<g id="fox" transform="translate(${FOX_DX} 0)">${FOX_SHADOW}${FOX}</g>`
      : '',
  ]
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">\n` +
    `<defs>\n<path id="badge" d="${badge(tile)}"/>${DEFS}${FOX_DEFS}</defs>\n` +
    `<g transform="translate(${inset} ${inset}) scale(${+scale.toFixed(6)}) translate(${-TILE.x} ${-TILE.y})">\n` +
    parts.filter(Boolean).join('\n') +
    '\n</g>\n</svg>\n'
  if (!colors) return svg
  const map = new Map(Object.entries(colors).map(([from, to]) => [from.toUpperCase(), to]))
  return svg.replace(/#[0-9A-Fa-f]{6}\b/g, (c) => map.get(c.toUpperCase()) ?? c)
}

// The glyph: the icon's fox without its shadow, for the macOS menu bar and the Windows and Linux
// trays, in one color whose opacity follows the drawing's luminance, so the parts stay apart by
// their shading. The opacity is lifted a little so the cheeks and ear tips come out solid.
const GLYPH_SHADE = { slope: 1.25, intercept: -0.05 }
// On a light ground the curve is inverted, so the drawing's brightest parts are the faintest ink and
// the fox keeps its light, instead of the murky negative the dark ground's curve gives in black.
const GLYPH_INK_SHADE = { slope: -0.95, intercept: 1.38 }
// The menu bar's canvas in points, with the fox 16 pt wide and centred; a tray's square is cut
// from it to the fox's width.
export const GLYPH_CANVAS = 18
const GLYPH_WIDTH = 16
// The dot of a waiting permission request, at the bottom right, with a gap around it.
const DOT = { cx: 14.5, cy: 14, r: 2.5, gap: 1.2 }

/** `menubar`, the 18 pt canvas of a macOS template image; `tray`, the fox filling a square. */
export const GLYPH_FRAMINGS = ['menubar', 'tray']

/**
 * The glyph as SVG text, `size` px wide, in `color`, with the dot when `dot` is set, shaded for a
 * `dark` or `light` ground.
 */
export function glyphSvg(
  framing = 'menubar',
  { size, color = '#000', dot = false, ground = 'dark' } = {},
) {
  if (!GLYPH_FRAMINGS.includes(framing)) throw new Error(`Unknown framing: ${framing}`)
  if (!['dark', 'light'].includes(ground)) throw new Error(`Unknown ground: ${ground}`)
  const { slope, intercept } = ground === 'light' ? GLYPH_INK_SHADE : GLYPH_SHADE
  // The paths hold only x, y pairs; their control points bound the symmetric fox.
  const numbers = Object.values(SHAPES).flatMap((d) => d.match(/-?[\d.]+/g).map(Number))
  const xs = numbers.filter((_, i) => i % 2 === 0)
  const ys = numbers.filter((_, i) => i % 2 === 1)
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const scale = GLYPH_WIDTH / (x1 - x0)
  const c = GLYPH_CANVAS / 2
  const transform = `translate(${c} ${c}) scale(${+scale.toFixed(6)}) translate(${-(x0 + x1) / 2} ${-(y0 + y1) / 2})`
  // The mask reads luminance, so the shade is white at the opacity the luminance gives.
  const shade =
    '<filter id="shade" color-interpolation-filters="sRGB"><feColorMatrix type="luminanceToAlpha"/>' +
    `<feComponentTransfer><feFuncA type="linear" slope="${slope}" intercept="${intercept}"/></feComponentTransfer>` +
    '<feComposite in2="SourceAlpha" operator="in" result="opacity"/>' +
    '<feFlood flood-color="#fff"/><feComposite in2="opacity" operator="in"/></filter>'
  const badge = dot
    ? `<circle cx="${DOT.cx}" cy="${DOT.cy}" r="${DOT.r + DOT.gap}" fill="#000"/>` +
      `<circle cx="${DOT.cx}" cy="${DOT.cy}" r="${DOT.r}" fill="#fff"/>`
    : ''
  const m = framing === 'tray' ? (GLYPH_CANVAS - GLYPH_WIDTH) / 2 : 0
  const side = GLYPH_CANVAS - 2 * m
  const px = size ?? side
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${px}" height="${px}" viewBox="${m} ${m} ${side} ${side}">` +
    `<defs>${FOX_DEFS}${shade}</defs>` +
    `<mask id="glyph" maskUnits="userSpaceOnUse" x="0" y="0" width="${GLYPH_CANVAS}" height="${GLYPH_CANVAS}">` +
    `<g transform="${transform}" filter="url(#shade)">${FOX}</g>${badge}</mask>` +
    `<rect width="${GLYPH_CANVAS}" height="${GLYPH_CANVAS}" fill="${color}" mask="url(#glyph)"/></svg>\n`
  )
}
