import { useState, useCallback, useEffect } from "react";
import { useAudioRecorder } from "../../hooks/useAudioRecorder";
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
import { Phone, PhoneOff, Loader2 } from "lucide-react";
import ConversationDisplay from "./ConversationDisplay";
import ActiveAudioPlayback from "./ActiveAudioPlayback";
import { toast } from "sonner";

const VoiceAgent = () => {
	const [isCallActive, setIsCallActive] = useState(false);

	const [activeAudio, setActiveAudio] = useState<{
		audioBuffer: ArrayBuffer;
		text: string;
	} | null>(null);

	const [callEndPending, setCallEndPending] = useState(false);

	const {
		state: botState,
		processingSubstatus,
		reset: resetBotState,
		setState,
	} = useBotStateStore();

	const handleCallEnd = useCallback(() => {
		const ts = new Date().toISOString();
		console.log(`[VOICE_AGENT ${ts}] Call end pending`);
		setCallEndPending(true);
	}, []);

	const handleAudioPlaybackEnd = useCallback(() => {
		setActiveAudio(null);

		if (callEndPending) {
			const ts = new Date().toISOString();
			console.log(`[VOICE_AGENT ${ts}] Call ended`);
			setState("call_ended", "Deflection complete");
			setIsCallActive(false);
			setCallEndPending(false);
		}
	}, [callEndPending, setState]);

	const { connected, sendAudio, messages, startCall } = useSocketConnection(
		import.meta.env.VITE_SERVER_URL || "http://localhost:3000",
		handleCallEnd,
	);

	const { isRecording, startRecording, stopRecording, error, audioStream } =
		useAudioRecorder(sendAudio);

	useEffect(() => {
		if (error) {
			toast.error(`Error in audio recording: ${error}`, {
				duration: 5000,
			});
		}
	}, [error]);

	// Watch for new assistant messages with audio and set as active audio
	useEffect(() => {
		const lastMessage = messages[messages.length - 1];
		if (
			lastMessage?.type === "assistant" &&
			lastMessage.audioBuffer &&
			lastMessage.text
		) {
			setActiveAudio({
				audioBuffer: lastMessage.audioBuffer,
				text: lastMessage.text,
			});
		}
	}, [messages]);

	// Auto-start recording when bot is ready to listen
	useEffect(() => {
		if (botState === "listening" && isCallActive && !isRecording) {
			startRecording();
		}
	}, [botState, isCallActive, isRecording, startRecording]);

	// Stop recording when bot starts speaking or processing (Caused bot audio to be sent as human input)
	useEffect(() => {
		if ((botState === "speaking" || botState === "processing") && isRecording) {
			stopRecording();
		}
	}, [botState, isRecording, stopRecording]);

	const handleStartCall = () => {
		startCall();
		setIsCallActive(true);
	};

	const handleEndCallClick = useCallback(() => {
		if (isRecording) {
			stopRecording();
		}
		setIsCallActive(false);
		resetBotState();
	}, [stopRecording, isRecording, resetBotState]);

	const handleSpeechEnd = useCallback(() => {
		if (isRecording && botState === "recording") {
			const ts = new Date().toISOString();
			console.log(`[VOICE_AGENT ${ts}] Speech ended`);
			stopRecording();
		}
	}, [isRecording, botState, stopRecording]);

	useVoiceActivityDetection(audioStream, isRecording, {
		onSpeechEnd: handleSpeechEnd,
		silenceThreshold: 30,
		silenceDuration: 2000,
	});

	useEffect(() => {
		if (isRecording && botState === "listening") {
			useBotStateStore.getState().setState("recording", "Recording started");
		}
	}, [isRecording, botState]);

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
						Call Simulation Mode - Powered by AI
					</p>
				</div>

				<div className="flex items-center gap-4 text-xs text-muted-foreground">
					<span>Models</span>
					<span>{`>`}</span>
					<span>Groq Whisper</span>
					<span>•</span>
					<span>Ollama phi3</span>
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

							{isSpeaking && isCallActive && (
								<div className="flex items-center justify-center gap-3 bg-blue-50 p-4 rounded-lg border-2 border-blue-200">
									<Loader2 className="h-4 w-4 animate-spin text-blue-600" />
									<div className="flex flex-col">
										<span className="text-blue-700 font-semibold">
											Bot is speaking...
										</span>
										<span className="text-blue-600 text-xs">
											Please wait for response to finish
										</span>
									</div>
								</div>
							)}

							{isListening && !isRecording && isCallActive && (
								<div className="flex items-center justify-center gap-3 bg-green-50 p-4 rounded-lg border-2 border-green-200">
									<div className="h-3 w-3 rounded-full bg-green-500 animate-pulse" />
									<div className="flex flex-col">
										<span className="text-green-700 font-semibold">
											Bot is listening...
										</span>
										<span className="text-green-600 text-xs">
											Recording will start automatically
										</span>
									</div>
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
							{/* Processing Status Card */}
							{processingSubstatus && (
								<div className="flex items-center justify-center gap-3 bg-red-50 p-4 rounded-lg border-2 border-red-200">
									<div className="h-3 w-3 rounded-full bg-red-500 animate-pulse" />
									<div className="flex flex-col">
										<Loader2 className="h-5 w-5 animate-spin text-blue-600" />
										<span className="text-blue-700 font-medium">
											{processingSubstatus}
										</span>
									</div>
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

					{/* Instructions Card */}
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
									<li>Recording starts when bot is listening</li>
									<li>Speak your question clearly</li>
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

				{/* Right Column: Active Audio & Conversation */}
				<div className="flex flex-col gap-4">
					{/* Active Audio Playback */}
					{activeAudio && (
						<ActiveAudioPlayback
							audioBuffer={activeAudio.audioBuffer}
							transcriptText={activeAudio.text}
							onPlaybackEnd={handleAudioPlaybackEnd}
						/>
					)}

					{/* Conversation Transcript */}
					<Card className="flex flex-col shadow-lg flex-1">
						<CardHeader className="border-b pb-4">
							<CardTitle className="text-lg">Call Transcript</CardTitle>
							<CardDescription className="text-xs">
								Text history of your conversation
							</CardDescription>
						</CardHeader>
						<CardContent className="flex-1 p-0 overflow-hidden">
							<ConversationDisplay messages={messages} />
						</CardContent>
					</Card>
				</div>
			</div>
		</div>
	);
};

export default VoiceAgent;
