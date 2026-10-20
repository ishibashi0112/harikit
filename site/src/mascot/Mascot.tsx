// patchiri のマスコット。縫い目のある当て布（パッチ）に、まつげのあるぱっちりした目。
// ふだんの顔（normal）と、うまくいった時のウインク（wink）がある。トップの絵（Hero.astro）とデモで使う。
// ヘッダーのロゴ（src/assets/logo.svg）とファビコン（public/favicon.svg）は、小さくても目が残るよう線を太くした別の絵。

const TEAL = "#12968a";
const INK = "#0f172a";
const CHEEK = "#ff9db5";
const STAR = "#f5b841";

export interface MascotProps {
  face?: "normal" | "wink";
  size?: number;
  /** 読み上げ用の名前。無ければ飾りとして読み上げない。 */
  title?: string;
  className?: string;
}

export function Mascot({ face = "normal", size = 220, title, className }: MascotProps) {
  const label = title ? { role: "img", "aria-label": title } : { "aria-hidden": true };
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 220 220" {...label}>
      <ellipse cx="110" cy="204" rx="62" ry="8" fill={INK} opacity="0.07" />
      <g transform="rotate(-6 110 110)">
        <rect x="30" y="34" width="160" height="152" rx="44" fill={TEAL} />
        <rect x="41" y="45" width="138" height="130" rx="35" fill="none" stroke="#fff" strokeOpacity="0.55" strokeWidth="3" strokeDasharray="9 7" />
        <ellipse cx="88" cy="106" rx="21" ry="25" fill="#fff" />
        <circle cx="91" cy="110" r="13" fill={INK} />
        <circle cx="85" cy="102" r="5.5" fill="#fff" />
        <path d="M72 90 L62 80 M80 83 L75 71 M90 81 L90 68" stroke="#fff" strokeWidth="5" strokeLinecap="round" />
        {face === "wink" ? (
          <>
            <path d="M112 104 Q132 122 152 104" fill="none" stroke="#fff" strokeWidth="6.5" strokeLinecap="round" />
            <path d="M118 111 L112 121 M132 114 L132 126 M146 111 L152 121" stroke="#fff" strokeWidth="4.5" strokeLinecap="round" />
          </>
        ) : (
          <>
            <ellipse cx="132" cy="106" rx="21" ry="25" fill="#fff" />
            <circle cx="135" cy="110" r="13" fill={INK} />
            <circle cx="129" cy="102" r="5.5" fill="#fff" />
            <path d="M148 90 L158 80 M140 83 L145 71 M130 81 L130 68" stroke="#fff" strokeWidth="5" strokeLinecap="round" />
          </>
        )}
        <ellipse cx="66" cy="138" rx="10" ry="6" fill={CHEEK} opacity="0.85" />
        <ellipse cx="154" cy="138" rx="10" ry="6" fill={CHEEK} opacity="0.85" />
        {face === "wink" ? (
          <path d="M99 140 Q110 155 121 140 Z" fill={INK} stroke={INK} strokeWidth="3" strokeLinejoin="round" />
        ) : (
          <path d="M100 142 Q110 152 120 142" fill="none" stroke={INK} strokeWidth="4" strokeLinecap="round" />
        )}
      </g>
      {face === "wink" ? (
        <>
          <path d="M184 60 L188 72 L200 76 L188 80 L184 92 L180 80 L168 76 L180 72 Z" fill={STAR} />
          <path d="M204 100 L206 106 L212 108 L206 110 L204 116 L202 110 L196 108 L202 106 Z" fill={STAR} />
        </>
      ) : (
        <path d="M190 18 L194 30 L206 34 L194 38 L190 50 L186 38 L174 34 L186 30 Z" fill={STAR} />
      )}
    </svg>
  );
}
