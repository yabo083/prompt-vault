import { useEffect, useState } from "react";
import { CheckCircle2, KeyRound } from "lucide-react";
import { claimLocalLaunch } from "./api";
import { Button } from "./components/ui/button";

export function consumeLaunchNonce(hash = location.hash) {
  if (!hash.startsWith("#launch=")) return "";
  history.replaceState(null, "", `${location.pathname}${location.search}#/`);
  try {
    return decodeURIComponent(hash.slice("#launch=".length));
  } catch {
    return "";
  }
}

export function LocalLaunchScreen({ nonce, onContinue }: { nonce: string; onContinue: () => void }) {
  const [state, setState] = useState<"claiming" | "complete" | "error">("claiming");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    claimLocalLaunch(nonce).then(() => {
      if (active) setState("complete");
    }).catch((claimError) => {
      if (!active) return;
      setError(claimError instanceof Error ? claimError.message : "本地启动链接无效");
      setState("error");
    });
    return () => { active = false; };
  }, [nonce]);
  return (
    <main className="launch-screen">
      <section className="launch-card" aria-live="polite">
        <div className={`launch-mark ${state}`} aria-hidden="true">{state === "complete" ? <CheckCircle2 size={24} /> : <KeyRound size={22} />}</div>
        {state === "claiming" && <div className="launch-heading"><h1>正在打开 Prompt Vault</h1><p>正在建立本地浏览器会话。</p></div>}
        {state === "error" && <><div className="launch-heading"><h1>启动链接不可用</h1><p>{error}</p></div><Button onClick={onContinue}>使用恢复凭据登录</Button></>}
        {state === "complete" && <>
          <div className="launch-heading"><h1>Prompt Vault 已就绪</h1><p>浏览器会话已建立，本机 CLI 已连接。</p></div>
          <Button onClick={onContinue}>打开 Prompt Vault</Button>
        </>}
      </section>
    </main>
  );
}
