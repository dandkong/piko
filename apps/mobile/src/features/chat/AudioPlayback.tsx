import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { Platform } from "react-native";
import { authHeaders } from "../../api/client";

/** One player per app: switching attachments stops the previous one without preloading every file. */
type Playback = {
  id?: string;
  playing: boolean;
  error: boolean;
  toggle: (id: string, uri: string) => void;
};
const AudioPlaybackContext = createContext<Playback | undefined>(undefined);

export function AudioPlaybackProvider({ children }: { children: ReactNode }) {
  const player = useAudioPlayer(null, { updateInterval: 300 });
  const status = useAudioPlayerStatus(player);
  const [id, setId] = useState<string>();
  const selected = useRef<string | undefined>(undefined);
  const requested = useRef(false);
  const generation = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [localError, setLocalError] = useState(false);

  // Show the requested state immediately rather than flashing between async loading statuses.
  useEffect(() => {
    if (status.error || status.didJustFinish ||
      (!status.playing && status.duration > 0 && status.currentTime >= status.duration)) {
      requested.current = false;
      setPlaying(false);
    }
  }, [status.error, status.didJustFinish, status.playing, status.duration, status.currentTime]);

  const toggle = useCallback((nextId: string, uri: string) => {
    const attempt = ++generation.current;
    setLocalError(false);
    const fail = () => {
      if (attempt !== generation.current) return;
      requested.current = false;
      setPlaying(false);
      setLocalError(true);
    };
    try {
      if (selected.current === nextId && requested.current) {
        requested.current = false;
        setPlaying(false);
        player.pause();
        return;
      }
      const replace = selected.current !== nextId || !!status.error || localError;
      if (replace) {
        player.pause();
        player.replace({ uri, headers: authHeaders(uri) });
        selected.current = nextId;
        setId(nextId);
      }
      requested.current = true;
      setPlaying(true);
      const current = player.currentStatus;
      if (!replace && (current.didJustFinish || (current.duration > 0 && current.currentTime >= current.duration))) {
        const seeking = player.seekTo(0);
        if (Platform.OS === "web") {
          void seeking.catch(fail);
          player.play(); // Keep play inside the browser's user gesture.
        } else {
          void seeking.then(() => { if (attempt === generation.current && requested.current) player.play(); }).catch(fail);
        }
      } else player.play();
    } catch { fail(); }
  }, [player, status.error, localError]);
  const value = useMemo(() => ({ id, playing,
    error: localError || !!status.error, toggle }), [id, playing, status.error, localError, toggle]);
  return <AudioPlaybackContext.Provider value={value}>{children}</AudioPlaybackContext.Provider>;
}

export function useAudioPlayback() {
  const value = useContext(AudioPlaybackContext);
  if (!value) throw new Error("Audio playback provider is missing.");
  return value;
}
