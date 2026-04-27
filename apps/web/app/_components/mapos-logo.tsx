import maposLogo from "@/public/mapos.svg";
import Image from "next/image";

export function MapOSLogo() {
  return (
    <div className="flex items-center gap-2.5" role="img" aria-label="MapOS">
      <Image src={maposLogo} alt="" height={24} className="shrink-0" unoptimized aria-hidden />
      <span
        className="font-[family-name:var(--font-geist-sans)] text-[17px] font-semibold tracking-[-0.01em]"
        aria-hidden
      >
        mapOS
      </span>
    </div>
  );
}
