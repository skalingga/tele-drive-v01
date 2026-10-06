import React, { useCallback, useEffect, useRef, useState } from "react";
import { Cloud, ShieldCheck, Smartphone, KeyRound, RefreshCw, Loader2, Lock } from "lucide-react";
import type { User, QrLoginState } from "@teledrive/shared";
import { api, ApiError } from "../lib/api";

interface AuthPageProps {
  onSuccess: (user: User) => void;
}

const POLL_MS = 1500;

/** Telegram QR login: scan with the Telegram app (Settings → Devices → Link Desktop Device). */
export const AuthPage: React.FC<AuthPageProps> = ({ onSuccess }) => {
  const [state, setState] = useState<QrLoginState | null>(null);
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const timer = useRef<number | null>(null);

  const stopPolling = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  const poll = useCallback(async () => {
    try {
      const { data } = await api.pollQrLogin();
      setState(data.state);
      if (data.qrSvg) setQrSvg(data.qrSvg);
      if (data.state.status === "success" && data.user) {
        onSuccess(data.user);
        return;
      }
      if (data.state.status === "expired" || data.state.status === "failed") return;
      timer.current = window.setTimeout(poll, POLL_MS);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? "Sesi login kedaluwarsa. Buat QR baru." : (err as Error).message);
      setState({ status: "expired" });
    }
  }, [onSuccess]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setState(null);
    setQrSvg(null);
    api
      .startQrLogin()
      .then(() => {
        if (!cancelled) void poll();
      })
      .catch(err => !cancelled && setError((err as Error).message));
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [attempt, poll]);

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setSubmitting(true);
    try {
      await api.submitQrPassword(password);
      setPassword("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const restart = () => {
    stopPolling();
    setAttempt(a => a + 1);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-950 to-blue-950 text-white flex flex-col justify-center items-center p-4 selection:bg-blue-500">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-3xl bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center text-white shadow-2xl shadow-blue-500/30 mx-auto mb-4">
            <Cloud className="w-9 h-9" />
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight">TeleDrive</h1>
          <p className="text-slate-400 text-sm mt-1 flex items-center justify-center gap-1.5">
            <ShieldCheck className="w-4 h-4 text-emerald-400" /> File Anda tersimpan di akun Telegram Anda sendiri
          </p>
        </div>

        <div className="bg-slate-900/80 backdrop-blur-xl border border-slate-800 rounded-3xl p-8 shadow-2xl">
          {state?.status === "password_required" ? (
            <form onSubmit={submitPassword} className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-amber-500/15 text-amber-400"><KeyRound className="w-5 h-5" /></div>
                <div>
                  <h2 className="font-semibold">Verifikasi dua langkah</h2>
                  <p className="text-xs text-slate-400">Akun Telegram Anda dilindungi password (2FA).</p>
                </div>
              </div>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="password"
                  autoFocus
                  autoComplete="current-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder={state.hint ? `Petunjuk: ${state.hint}` : "Password 2FA Telegram"}
                  className="w-full pl-10 pr-4 py-3 rounded-xl bg-slate-950 border border-slate-800 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none text-sm"
                />
              </div>
              {state.passwordError && <p className="text-xs text-rose-400">{state.passwordError}</p>}
              <button
                type="submit"
                disabled={submitting || !password}
                className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 font-semibold text-sm flex items-center justify-center gap-2"
              >
                {submitting && <Loader2 className="w-4 h-4 animate-spin" />} Lanjutkan
              </button>
            </form>
          ) : (
            <div className="flex flex-col items-center text-center">
              <h2 className="font-semibold text-lg mb-1">Masuk dengan Telegram</h2>
              <p className="text-xs text-slate-400 mb-5">Scan kode QR ini dengan aplikasi Telegram di HP Anda.</p>

              <div className="w-60 h-60 rounded-2xl bg-white p-3 flex items-center justify-center mb-5">
                {state?.status === "expired" || state?.status === "failed" ? (
                  <button onClick={restart} className="flex flex-col items-center gap-2 text-slate-700 text-sm font-medium">
                    <RefreshCw className="w-8 h-8" /> Buat QR baru
                  </button>
                ) : qrSvg ? (
                  <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg)}`} alt="Kode QR login Telegram" className="w-full h-full" />
                ) : (
                  <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
                )}
              </div>

              <ol className="text-left text-xs text-slate-400 space-y-1.5 w-full">
                <li className="flex gap-2"><Smartphone className="w-4 h-4 shrink-0 text-blue-400" /> Buka Telegram → <b className="text-slate-200">Settings → Devices → Link Desktop Device</b></li>
                <li className="flex gap-2"><span className="w-4 text-center text-blue-400 font-bold">2</span> Arahkan kamera ke kode QR di atas</li>
                <li className="flex gap-2"><span className="w-4 text-center text-blue-400 font-bold">3</span> TeleDrive membuat channel privat "TeleDrive Storage" di akun Anda</li>
              </ol>
            </div>
          )}

          {error && <p className="mt-4 text-xs text-rose-400 text-center">{error}</p>}
          {state?.status === "failed" && <p className="mt-4 text-xs text-rose-400 text-center">{state.message}</p>}
        </div>

        <p className="text-[11px] text-slate-500 text-center mt-6 leading-relaxed">
          Login ini memberi TeleDrive akses ke akun Telegram Anda (seperti aplikasi Telegram Desktop). Session disimpan terenkripsi
          dan dihapus saat Anda logout. Anda bisa mencabut akses kapan saja di Telegram → Settings → Devices.
        </p>
      </div>
    </div>
  );
};
