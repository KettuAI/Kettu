// Amp mark: ACP Registry, https://github.com/agentclientprotocol/registry (Apache-2.0).
const AMP_1 =
  'M13.9197 13.61L17.3816 26.566L14.242 27.4049L11.2645 16.2643L0.119926 13.2906L0.957817 10.15L13.9197 13.61Z'

const AMP_2 = 'M13.7391 16.0892L4.88169 24.9056L2.58872 22.6019L11.4461 13.7865L13.7391 16.0892Z'

const AMP_3 =
  'M18.9386 8.58315L22.4005 21.5392L19.2609 22.3781L16.2833 11.2374L5.13879 8.26381L5.97668 5.12318L18.9386 8.58315Z'

const AMP_4 =
  'M23.9803 3.55632L27.4422 16.5124L24.3025 17.3512L21.325 6.21062L10.1805 3.23698L11.0183 0.0963593L23.9803 3.55632Z'

export const viewBox = '0 0 28 28'

/** The mark in `currentColor`, as the ACP Registry ships it. */
export function Body() {
  return (
    <>
      <path fill="currentColor" d={AMP_1} />
      <path fill="currentColor" d={AMP_2} />
      <path fill="currentColor" d={AMP_3} />
      <path fill="currentColor" d={AMP_4} />
    </>
  )
}
