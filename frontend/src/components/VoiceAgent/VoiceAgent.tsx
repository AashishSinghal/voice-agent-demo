import { useState, useCallback, useEffect, useRef } from "react";
import { useAudioRecorder } from "../../hooks/useAudioRecorder";
import { useAudioPlayback } from "../../hooks/useAudioPlayback";
import { useMicStream } from "../../hooks/useMicStream";
import { useSocketConnection } from "../../hooks/useSocketConnection";
import { useVoiceActivityDetection } from "../../hooks/useVoiceActivityDetection";
import { useBotStateStore } from "../../stores/useBotStateStore";
import { Button } from "../ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Phone, PhoneOff, Loader2, Zap } from "lucide-react";
import ConversationDisplay from "./ConversationDisplay";
import { toast } from "sonner";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3000";

const VoiceAgent = () => {
	const [isCallActive, setIsCallActive] = useState(false);
	const [callEndPending, setCallEndPending] = useState(false);
	const [didBargeIn, setDidBargeIn] = useState(false);

	const {
		state: botState,
		processingSubstatus,
		reset: resetBotState,
		setState,
	} = useBotStateStore();

	const { stream, acquire, release, error: micError } = useMicStream();

	// Latest bot state, readable from callbacks without re-subscribing them.
	const botStateRef = useRef(botState);
	botStateRef.current = botState;

	const isCallActiveRef = useRef(isCallActive);
	isCallActiveRef.current = isCallActive;

	// --- playback -----------------------------------------------------------

	const notifyRef = useRef<(turnId: number) => void>(() => {});

	const { enqueue, markTurnComplete, stop: stopPlayback } = useAudioPlayback({
		onTurnPlayed: (turnId) => {
			// Real completion signal — replaces the old character-count timer.
			notifyRef.current(turnId);
			if (callEndPending) {
				setState("call_ended", "Deflection complete");
				setIsCallActive(false);
				setCallEndPending(false);
			}
		},
	});

	// --- socket -------------------------------------------------------------

	const {
		connected,
		messages,
		metrics,
		sendAudio,
		startCall,
		interrupt,
		notifyPlaybackComplete,
	} = useSocketConnection(SERVER_URL, {
		onAudioChunk: (chunk) => enqueue(chunk),
		onTurnComplete: (turnId) => markTurnComplete(turnId),
		onCancelled: () => setState("listening", "Turn cancelled by barge-in"),
		onReadyToListen: () => {
			if (isCallActiveRef.current) setState("listening", "Server ready");
		},
		onCallEnd: () => setCallEndPending(true),
	});

	notifyRef.current = notifyPlaybackComplete;

	// --- recording ----------------------------------------------------------

	const { isRecording, startRecording, stopRecording, discardRecording, error: recorderError } =
		useAudioRecorder(sendAudio);

	useEffect(() => {
		const error = micError || recorderError;
		if (error) toast.error(error, { duration: 5000 });
	}, [micError, recorderError]);

	// Start capturing as soon as the agent is ready for the caller to speak.
	useEffect(() => {
		if (botState === "listening" && isCallActive && !isRecording && stream) {
			startRecording(stream);
			setState("recording", "Recording started");
		}
	}, [botState, isCallActive, isRecording, stream, startRecording, setState]);

	// --- turn boundaries ----------------------------------------------------

	const handleSpeechEnd = useCallback(() => {
		if (botStateRef.current === "recording") {
			stopRecording(); // flushes the blob to the server
			setState("processing", "Caller finished speaking");
		}
	}, [stopRecording, setState]);

	/**
	 * Barge-in. If the caller speaks while the agent is talking, silence the
	 * agent immediately, tell the server to abandon the turn, and start
	 * recording the interruption.
	 */
	const handleSpeechStart = useCallback(() => {
		const state = botStateRef.current;
		if (state !== "speaking" && state !== "greeting") return;

		console.log("[VOICE_AGENT] Barge-in detected");
		stopPlayback();
		interrupt();
		setDidBargeIn(true);
		setState("listening", "Caller interrupted");
	}, [stopPlayback, interrupt, setState]);

	// VAD runs for the whole call, not just while recording, so it can hear the
	// caller talk over the agent.
	useVoiceActivityDetection(stream, isCallActive, {
		onSpeechEnd: handleSpeechEnd,
		onSpeechStart: handleSpeechStart,
		silenceThreshold: 30,
		silenceDuration: 2000,
		speechThreshold: 45,
		speechDuration: 300,
	});

	// --- call control -------------------------------------------------------

	const handleStartCall = useCallback(async () => {
		const micStream = await acquire();
		if (!micStream) return;

		setDidBargeIn(false);
		setIsCallActive(true);
		startCall();
	}, [acquire, startCall]);

	const handleEndCallClick = useCallback(() => {
		discardRecording();
		stopPlayback();
		release();
		setIsCallActive(false);
		setCallEndPending(false);
		resetBotState();
	}, [discardRecording, stopPlayback, release, resetBotState]);

	useEffect(() => release, [release]);

	const isProcessing = botState === "processing";
	const isSpeaking = botState === "speaking" || botState === "greeting";
	const isListening = botState === "listening";
	const callEnded = botState === "call_ended";

	return (
		<div className="h-screen bg-gradient-to-br from-gray-50 to-gray-100 p-6">
			<div className="mb-6 flex justify-between items-center">
				<div>
					<h1 className="text-3xl font-bold mb-2">Wise Voice Agent</h1>
					<p className="text-muted-foreground">
						Streaming call simulation with barge-in
					</p>
				</div>

				<div className="flex items-center gap-4 text-xs text-muted-foreground">
					<span>Pipeline</span>
					<span>{`>`}</span>
					<span>Groq Whisper</span>
					<span>•</span>
					<span>Streaming LLM</span>
					<span>•</span>
					<span>Piper TTS</span>
				</div>
			</div>

			<div className="grid grid-cols-2 gap-6 h-[calc(100vh-140px)]">
				<div className="flex flex-col gap-4">
					<Card className="shadow-lg">
						<CardHeader>
							<CardTitle className="text-lg">
								<div className="flex justify-between">
									Call Controls
									<div className="flex items-center justify-center gap-2">
										<div
											className={`h-2.5 w-2.5 rounded-full ${
												connected ? "bg-green-500 animate-pulse" : "bg-red-500"
											}`}
										/>
										<span className="text-sm font-medium text-muted-foreground">
											{connected ? "Connected" : "Disconnected"}
										</span>
									</div>
								</div>
							</CardTitle>
						</CardHeader>
						<CardContent className="space-y-4">
							{isCallActive && (
								<div className="text-xs text-gray-500 border border-gray-200 rounded p-2 bg-gray-50">
									<span className="font-mono">
										Bot State: <strong>{botState}</strong>
									</span>
								</div>
							)}

							{metrics && (
								<div className="flex items-center gap-3 rounded-lg border-2 border-purple-200 bg-purple-50 p-3">
									<Zap className="h-4 w-4 text-purple-600" />
									<div className="flex flex-col text-xs text-purple-800">
										<span className="font-semibold">
											First audio in {metrics.firstAudioMs ?? "—"} ms
										</span>
										<span className="text-purple-600">
											first token {metrics.firstTokenMs ?? "—"} ms · full
											response {metrics.totalMs} ms · {metrics.chunks} chunks
										</span>
									</div>
								</div>
							)}

							{isSpeaking && isCallActive && (
								<div className="flex items-center justify-center gap-3 bg-blue-50 p-4 rounded-lg border-2 border-blue-200">
									<Loader2 className="h-4 w-4 animate-spin text-blue-600" />
									<div className="flex flex-col">
										<span className="text-blue-700 font-semibold">
											Bot is speaking...
										</span>
										<span className="text-blue-600 text-xs">
											Just start talking to interrupt
										</span>
									</div>
								</div>
							)}

							{isListening && !isRecording && isCallActive && (
								<div className="flex items-center justify-center gap-3 bg-green-50 p-4 rounded-lg border-2 border-green-200">
									<div className="h-3 w-3 rounded-full bg-green-500 animate-pulse" />
									<span className="text-green-700 font-semibold">
										Bot is listening...
									</span>
								</div>
							)}

							{isRecording && (
								<div className="flex items-center justify-center gap-3 bg-red-50 p-4 rounded-lg border-2 border-red-200">
									<div className="h-3 w-3 rounded-full bg-red-500 animate-pulse" />
									<div className="flex flex-col">
										<span className="text-red-700 font-semibold">
											Recording...
										</span>
										<span className="text-red-600 text-xs">
											Auto-stops after 2s of silence
										</span>
									</div>
								</div>
							)}

							{didBargeIn && (
								<div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
									Barge-in detected — previous response cancelled mid-sentence.
								</div>
							)}

							{processingSubstatus && (
								<div className="flex items-center gap-3 bg-blue-50 p-3 rounded-lg border-2 border-blue-200">
									<Loader2 className="h-4 w-4 animate-spin text-blue-600" />
									<span className="text-blue-700 font-medium text-sm">
										{processingSubstatus}
									</span>
								</div>
							)}

							{!isCallActive ? (
								<Button
									onClick={handleStartCall}
									disabled={!connected || isProcessing || callEnded}
									size="lg"
									className="w-full h-16 text-lg"
								>
									<Phone className="mr-2 h-6 w-6" />
									Start Call
								</Button>
							) : (
								<Button
									onClick={handleEndCallClick}
									variant="destructive"
									size="lg"
									className="w-full h-16 text-lg"
									disabled={callEnded}
								>
									<PhoneOff className="mr-2 h-6 w-6" />
									End Call
								</Button>
							)}

							{callEnded && (
								<div className="bg-orange-50 border border-orange-200 p-4 rounded-lg">
									<p className="text-sm text-orange-900 font-medium">
										Call ended - Refresh page to start a new call
									</p>
								</div>
							)}
						</CardContent>
					</Card>

					<Card className="shadow-lg flex-1">
						<CardHeader>
							<CardTitle className="text-lg">How It Works</CardTitle>
						</CardHeader>
						<CardContent className="flex gap-4">
							<div className="space-y-2">
								<p className="text-sm font-medium">Call Simulation:</p>
								<ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground">
									<li>Click "Start Call"</li>
									<li>Bot greets you automatically</li>
									<li>Speak whenever you like</li>
									<li>Talk over the bot to interrupt it</li>
									<li>Pauses auto-detected (2s silence)</li>
									<li>Bot answers or transfers to human</li>
								</ol>
							</div>
							<div className="p-4 bg-blue-50 rounded-lg flex-1">
								<p className="text-xs font-medium text-blue-900 mb-2">
									Example Questions:
								</p>
								<div className="space-y-1 text-xs text-blue-700">
									<p>✓ "Where is my money?"</p>
									<p>✓ "When will my transfer arrive?"</p>
									<p>✓ "Why is my transfer delayed?"</p>
									<p className="mt-2 pt-2 border-t border-blue-200">
										✗ "What are your fees?" → Transfers to human
									</p>
								</div>
							</div>
						</CardContent>
					</Card>
				</div>

				<Card className="flex flex-col shadow-lg">
					<CardHeader className="border-b pb-4">
						<CardTitle className="text-lg">Call Transcript</CardTitle>
						<CardDescription className="text-xs">
							Streams in as the agent generates it
						</CardDescription>
					</CardHeader>
					<CardContent className="flex-1 p-0 overflow-hidden">
						<ConversationDisplay messages={messages} />
					</CardContent>
				</Card>
			</div>
		</div>
	);
};

export default VoiceAgent;
