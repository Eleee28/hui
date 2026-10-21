/**
 * A GPT-Live call's capabilities in the browser (HUI-18): the microphone with
 * echo cancellation, a native RTCPeerConnection carrying it to ChatGPT with
 * the call's data channel, the bot's voice on a hidden audio element, both
 * levels from analysers (for activity and the bot's face), over the gateway's
 * call routes (src/api/calls.ts), whose requests its creator passes in. No dependencies; `LiveCall` (live-call.ts)
 * holds the logic.
 */
import type { CallDelegationResult, CallLine, CallTaskResult } from "../../api/schema/calls.ts";
import type { LiveCallPlatform, LiveConnection, LiveMicrophone } from "./live-call.ts";
import type { subscribeSession } from "../../api/sessions.ts";
import type { deleteCall, postCallDelegation, postCallHeartbeat, postCallLines, postCallTask, startBotCall } from "../../api/calls.ts";
import { frameLevel } from "./level.ts";
import { microphoneContext, microphoneErrorMessage } from "./voice.ts";

/** The level (0–1) of what an analyser hears now. */
function analyserLevel(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buffer);
  return frameLevel(buffer);
}

function analyse(context: AudioContext, stream: MediaStream): () => number {
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  context.createMediaStreamSource(stream).connect(analyser);
  const buffer = new Float32Array(analyser.fftSize);
  return () => analyserLevel(analyser, buffer);
}

type LiveCallApi = {
  startBotCall: typeof startBotCall;
  postCallDelegation: typeof postCallDelegation;
  postCallTask: typeof postCallTask;
  postCallLines: typeof postCallLines;
  postCallHeartbeat: typeof postCallHeartbeat;
  deleteCall: typeof deleteCall;
  subscribeSession: typeof subscribeSession;
};

/** A GPT-Live call with one bot, through the gateway's call routes. */
export function liveCallPlatform(bot: { id: string; sessionId: string }, api: LiveCallApi): LiveCallPlatform {
  let context: AudioContext | undefined;
  let microphoneStream: MediaStream | undefined;
  const audio = () => (context ??= new AudioContext());
  return {
    async openMicrophone(): Promise<LiveMicrophone> {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch (error) {
        throw new Error(microphoneErrorMessage(error, microphoneContext()));
      }
      const ctx = audio();
      await ctx.resume().catch(() => {});
      const level = analyse(ctx, stream);
      microphoneStream = stream;
      return {
        setEnabled: (enabled: boolean) => { for (const track of stream.getAudioTracks()) track.enabled = enabled; },
        level,
        close: () => { for (const track of stream.getTracks()) track.stop(); },
      };
    },

    async connect(_microphone, handlers): Promise<LiveConnection> {
      const stream = microphoneStream;
      if (!stream) throw new Error("The microphone is not open.");
      const peer = new RTCPeerConnection();
      const player = document.createElement("audio");
      player.autoplay = true;
      player.setAttribute("playsinline", "");
      player.dataset["huiCallAudio"] = "";
      player.hidden = true;
      document.body.append(player);
      let voiceLevel: () => number = () => 0;
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        channel.close();
        peer.close();
        player.srcObject = null;
        player.remove();
        void context?.close().catch(() => {});
        context = undefined;
      };
      for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
      const channel = peer.createDataChannel("oai-events");
      channel.addEventListener("open", () => handlers.onOpen());
      channel.addEventListener("message", (event) => handlers.onMessage(event.data));
      channel.addEventListener("close", () => { if (!closed) handlers.onLost("The call's connection to GPT-Live closed."); });
      peer.addEventListener("track", (event) => {
        const remote = event.streams[0] ?? new MediaStream([event.track]);
        player.srcObject = remote;
        void player.play().catch(() => {});
        // Chromium hands Web Audio a remote stream's samples only while a media element plays it too.
        voiceLevel = analyse(audio(), remote);
      });
      let lostTimer: ReturnType<typeof setTimeout> | undefined;
      peer.addEventListener("connectionstatechange", () => {
        if (closed) return;
        clearTimeout(lostTimer);
        if (peer.connectionState === "failed") handlers.onLost("The call's connection to GPT-Live failed.");
        // A brief network change can recover by itself.
        else if (peer.connectionState === "disconnected") lostTimer = setTimeout(() => { if (!closed && peer.connectionState !== "connected") handlers.onLost("The call's connection to GPT-Live was lost."); }, 5_000);
      });
      try {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        const started = await api.startBotCall(bot.id, offer.sdp ?? "");
        await peer.setRemoteDescription({ type: "answer", sdp: started.answer });
        return {
          callId: started.callId,
          voice: started.voice,
          send: (event) => {
            if (channel.readyState !== "open") return false;
            channel.send(JSON.stringify(event));
            return true;
          },
          level: () => voiceLevel(),
          setSpeakerMuted: (muted) => { player.muted = muted; },
          close,
        };
      } catch (error) {
        close();
        throw error;
      }
    },

    async delegate(callId, id, request, signal): Promise<CallDelegationResult> {
      return api.postCallDelegation(bot.id, callId, id, request, signal);
    },

    async waitTask(callId, task, signal): Promise<CallTaskResult> {
      return api.postCallTask(bot.id, callId, task, signal);
    },

    async writeLines(callId, lines: readonly (CallLine & { at: number })[]) {
      await api.postCallLines(bot.id, callId, lines);
    },

    async heartbeat(callId) {
      await api.postCallHeartbeat(bot.id, callId);
    },

    async end(callId, leaving) {
      await api.deleteCall(bot.id, callId, leaving);
    },

    watchTools(onTool) {
      return api.subscribeSession(bot.sessionId, {
        onSnapshot: () => undefined,
        onStatus: () => undefined,
        onEvent: (event) => {
          if (event.type === "tool_start") onTool(event.name);
          else if (event.type === "tool_end" || event.type === "settled") onTool(undefined);
        },
        onTranscript: () => undefined,
        onModel: () => undefined,
        onThinking: () => undefined,
        onConnection: () => undefined,
      });
    },

    setTimer: (callback, ms) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
    setInterval: (callback, ms) => {
      const timer = setInterval(callback, ms);
      return () => clearInterval(timer);
    },
    now: () => Date.now(),
  };
}
