import { useState, useCallback } from "react";
import { useAudioRecorder } from "../../hooks/useAudioRecorder";
import { useSocketConnection } from "../../hooks/useSocketConnection";
import { useVoiceActivityDetection } from "../../hooks/useVoiceActivityDetection";
import { Button } from "../ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Switch } from "../ui/switch";
import { Mic, MicOff, Loader2 } from "lucide-react";
import ConversationDisplay from "./ConversationDisplay";

const VoiceAgent = () => {
	const [isCallActive, setIsCallActive] = useState(false);
	const [vadEnabled, setVadEnabled] = useState(true); // Toggle for auto-stop

	// Empty handler since AudioPlayer component handles playback
	const handleAudioResponse = useCallback(() => {
		// Audio playback is handled by AudioPlayer component with autoPlay prop
	}, []);

	const { connected, sendAudio, isProcessing, messages, processingStatus } =
		useSocketConnection(
			import.meta.env.VITE_SERVER_URL || "http://localhost:3000",
			handleAudioResponse,
		);

	const { isRecording, startRecording, stopRecording, error, audioStream } =
		useAudioRecorder(sendAudio);

	const handleStartCall = async () => {
		await startRecording();
		setIsCallActive(true);
	};

	const handleEndCall = useCallback(() => {
		stopRecording();
		setIsCallActive(false);
	}, [stopRecording]);

	// Auto-stop recording when speech ends (VAD)
	const handleSpeechEnd = useCallback(() => {
		if (isRecording && vadEnabled && !isProcessing) {
			console.log("VAD: Speech ended, auto-stopping recording");
			handleEndCall();
		}
	}, [isRecording, vadEnabled, isProcessing, handleEndCall]);

	// Voice Activity Detection
	useVoiceActivityDetection(audioStream, isRecording && vadEnabled, {
		onSpeechEnd: handleSpeechEnd,
		silenceThreshold: 30,
		silenceDuration: 2000, // 2 seconds of silence
	});

	return (
		<div className="h-screen bg-gradient-to-br from-gray-50 to-gray-100 p-6">
			<div className="mb-6 flex justify-between items-center">
				<div>
					<h1 className="text-3xl font-bold mb-2">Wise Voice Agent</h1>
					<p className="text-muted-foreground">
						Ask about your money transfer status
					</p>
				</div>

				{/* Tech Stack Info */}
				<div className="flex items-center gap-4 text-xs text-muted-foreground">
					<span>Groq Whisper</span>
					<span>•</span>
					<span>Ollama phi3</span>
					<span>•</span>
					<span>Piper TTS</span>
					<span>•</span>
					<span>Socket.io</span>
				</div>
			</div>

			<div className="grid grid-cols-2 gap-6 h-[calc(100vh-140px)]">
				<div className="flex flex-col gap-4">
					<Card className="shadow-lg">
						<CardHeader>
							<CardTitle className="text-lg">
								<div className="flex justify-between">
									Recording Controls
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
							{isRecording && !isProcessing && (
								<div className="flex items-center justify-center gap-3 bg-red-50 p-4 rounded-lg border-2 border-red-200">
									<div className="h-3 w-3 rounded-full bg-red-500 animate-pulse" />
									<div className="flex flex-col">
										<span className="text-red-700 font-semibold">
											Recording...
										</span>
										<span className="text-red-600 text-xs">
											{vadEnabled
												? "Auto-stops after 2s silence"
												: "Click stop when done"}
										</span>
									</div>
								</div>
							)}

							{!isCallActive ? (
								<Button
									onClick={handleStartCall}
									disabled={!connected || isProcessing}
									size="lg"
									className="w-full h-16 text-lg"
								>
									<Mic className="mr-2 h-6 w-6" />
									Start Conversation
								</Button>
							) : (
								<Button
									onClick={handleEndCall}
									variant="destructive"
									size="lg"
									className="w-full h-16 text-lg"
									disabled={isProcessing}
								>
									<MicOff className="mr-2 h-6 w-6" />
									Stop & Send
								</Button>
							)}

							<div className="flex items-center justify-between bg-muted/50 p-3 rounded-lg">
								<div className="space-y-0.5">
									<label htmlFor="vad-toggle" className="text-sm font-medium">
										Auto-detect silence
									</label>
									<p className="text-xs text-muted-foreground">
										Auto-stop after 2s silence
									</p>
								</div>
								<Switch
									id="vad-toggle"
									checked={vadEnabled}
									onCheckedChange={setVadEnabled}
									disabled={isRecording}
								/>
							</div>
						</CardContent>
					</Card>

					{processingStatus && (
						<Card className="shadow-lg">
							<CardContent className="pt-6">
								<div className="flex items-center justify-center gap-3">
									<Loader2 className="h-5 w-5 animate-spin text-blue-600" />
									<span className="text-blue-700 font-medium">
										{processingStatus}
									</span>
								</div>
							</CardContent>
						</Card>
					)}

					{messages.length === 0 && !isCallActive && !error && (
						<Card className="shadow-lg flex-1">
							<CardHeader>
								<CardTitle className="text-lg">Instructions</CardTitle>
							</CardHeader>
							<CardContent className="space-y-3">
								<ol className="list-decimal list-inside space-y-2 text-sm">
									<li>Click "Start Conversation"</li>
									<li>Allow microphone access</li>
									<li>Ask your question clearly</li>
									<li>
										{vadEnabled
											? "Pause 2s for auto-stop"
											: 'Click "Stop & Send"'}
									</li>
								</ol>
								<div className="mt-4 p-3 bg-blue-50 rounded-lg">
									<p className="text-xs font-medium text-blue-900 mb-1">
										Example questions:
									</p>
									<p className="text-xs text-blue-700">
										• Where is my money?
										<br />• When will my transfer arrive?
										<br />• Why is my transfer delayed?
									</p>
								</div>
							</CardContent>
						</Card>
					)}

					{error && (
						<Card className="shadow-lg border-destructive">
							<CardContent className="pt-6">
								<div className="text-destructive">
									<p className="font-semibold mb-1">Error</p>
									<p className="text-sm">{error}</p>
								</div>
							</CardContent>
						</Card>
					)}
				</div>
				<Card className="flex flex-col shadow-lg">
					<CardHeader className="border-b pb-4">
						<CardTitle className="text-lg">Conversation</CardTitle>
						<CardDescription className="text-xs">
							Your questions and AI responses appear here
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
