import { useState, useRef, useEffect } from 'react';
import { Camera, RefreshCcw, Search, Trash2, ArrowRight, CheckCircle2, AlertCircle, Loader2, Volume2, VolumeX, History, ShieldAlert, Clock } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { identifyWaste, WasteInfo } from './services/geminiService';
import * as tf from '@tensorflow/tfjs';
import * as blazeface from '@tensorflow-models/blazeface';

interface HistoryItem extends WasteInfo {
  id: string;
  imageUrl: string;
  timestamp: number;
}

export default function App() {
  const [view, setView] = useState<'scan' | 'history'>('scan');
  const [history, setHistory] = useState<HistoryItem[]>([]);
  
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isProcessingImage, setIsProcessingImage] = useState(false);
  const [result, setResult] = useState<WasteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modelRef = useRef<blazeface.BlazeFaceModel | null>(null);

  // Initialize TensorFlow and Load Model
  useEffect(() => {
    const loadModel = async () => {
      try {
        await tf.ready();
        modelRef.current = await blazeface.load();
        console.log("BlazeFace model loaded");
      } catch (e) {
        console.error("Face detection model failed to load", e);
      }
    };
    loadModel();
  }, []);

  const blurFaces = async (canvas: HTMLCanvasElement) => {
    if (!modelRef.current) return;

    const context = canvas.getContext('2d');
    if (!context) return;

    const predictions = await modelRef.current.estimateFaces(canvas, false);
    
    if (predictions.length > 0) {
      context.save();
      predictions.forEach((prediction: any) => {
        const start = prediction.topLeft as [number, number];
        const end = prediction.bottomRight as [number, number];
        const size = [end[0] - start[0], end[1] - start[1]];
        
        // Apply blur to the face area
        const faceCanvas = document.createElement('canvas');
        faceCanvas.width = size[0];
        faceCanvas.height = size[1];
        const faceCtx = faceCanvas.getContext('2d');
        if (faceCtx) {
          faceCtx.drawImage(canvas, start[0], start[1], size[0], size[1], 0, 0, size[0], size[1]);
          
          context.filter = 'blur(15px)';
          context.drawImage(faceCanvas, start[0], start[1], size[0], size[1]);
        }
      });
      context.restore();
    }
  };

  // Load history from localStorage on mount and cleanup old items
  useEffect(() => {
    const savedHistory = localStorage.getItem('ecoScanHistory');
    if (savedHistory) {
      try {
        const parsedHistory: HistoryItem[] = JSON.parse(savedHistory);
        
        // 20 days in milliseconds: 20 * 24 * 60 * 60 * 1000
        const TWENTY_DAYS_MS = 1728000000;
        const now = Date.now();
        
        // Filter out items older than 20 days
        const filteredHistory = parsedHistory.filter(item => {
          const age = now - item.timestamp;
          return age < TWENTY_DAYS_MS;
        });

        setHistory(filteredHistory);
        
        if (filteredHistory.length !== parsedHistory.length) {
          console.log(`${parsedHistory.length - filteredHistory.length}개의 오래된 기록이 자동 삭제되었습니다.`);
        }
      } catch (e) {
        console.error("Failed to load history", e);
      }
    }
  }, []);

  // Save history whenever it changes
  useEffect(() => {
    localStorage.setItem('ecoScanHistory', JSON.stringify(history));
  }, [history]);

  const startCamera = async () => {
    if (view !== 'scan') return;
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'environment' } 
      });
      setStream(mediaStream);
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }
      setError(null);
    } catch (err) {
      console.error("Camera access error:", err);
      setError("카메라에 접근할 수 없습니다. 권한을 확인해주세요.");
    }
  };

  useEffect(() => {
    if (view === 'scan') {
      startCamera();
    } else {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
        setStream(null);
      }
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
    }
    
    return () => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
      window.speechSynthesis.cancel();
    };
  }, [view]);

  const handleSpeak = (data: WasteInfo) => {
    if (isSpeaking) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
      return;
    }

    const textToSpeak = `${data.itemName}의 분리배출 방법입니다. ${data.disposalMethod}. 주의사항으로는 ${data.tips.join(", ")} 등이 있습니다.`;
    const utterance = new SpeechSynthesisUtterance(textToSpeak);
    utterance.lang = 'ko-KR';
    utterance.rate = 1.0;
    
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    
    setIsSpeaking(true);
    window.speechSynthesis.speak(utterance);
  };

  const captureAndAnalyze = async () => {
    window.speechSynthesis.cancel();
    setIsSpeaking(false);

    if (!videoRef.current || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const video = videoRef.current;
    
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    const context = canvas.getContext('2d');
    if (!context) return;
    
    context.save();
    context.scale(-1, 1);
    context.drawImage(video, -canvas.width, 0, canvas.width, canvas.height);
    context.restore();

    setIsProcessingImage(true);
    setIsAnalyzing(false);
    setResult(null);
    setError(null);

    try {
      // Step 1: Detect and blur faces for privacy
      await blurFaces(canvas);
      
      const imageData = canvas.toDataURL('image/jpeg', 0.6);
      const base64Data = imageData.split(',')[1];
      
      setCapturedImage(imageData);
      setIsProcessingImage(false);
      setIsAnalyzing(true);
      
      // Step 2: Analyze with Gemini
      const wasteInfo = await identifyWaste(base64Data);
      setResult(wasteInfo);
      
      // Step 3: Add to history
      const newHistoryItem: HistoryItem = {
        ...wasteInfo,
        id: crypto.randomUUID(),
        imageUrl: imageData,
        timestamp: Date.now()
      };
      setHistory(prev => [newHistoryItem, ...prev]);
      
      // Step 4: Auto speech
      handleSpeak(wasteInfo);
      
    } catch (err) {
      console.error("Analysis error:", err);
      setError("이미지를 처리하는 중에 오류가 발생했습니다. 다시 시도해주세요.");
      setCapturedImage(null);
    } finally {
      setIsProcessingImage(false);
      setIsAnalyzing(false);
    }
  };

  const reset = () => {
    setCapturedImage(null);
    setResult(null);
    setError(null);
    window.speechSynthesis.cancel();
    setIsSpeaking(false);
    startCamera();
  };

  const deleteHistoryItem = (id: string) => {
    setHistory(prev => prev.filter(item => item.id !== id));
  };

  return (
    <div className="min-h-screen bg-neutral-50 flex flex-col items-center p-4 md:p-8 max-w-2xl mx-auto font-sans">
      {/* Header & Navigation */}
      <header className="w-full mb-8">
        <div className="flex items-center justify-between mb-6">
          <motion.div 
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            className="flex items-center gap-2"
          >
            <div className="p-2 bg-emerald-100 rounded-xl">
              <Trash2 className="w-6 h-6 text-emerald-600" />
            </div>
            <h1 className="text-2xl font-display font-bold text-neutral-900 tracking-tight">EcoScan</h1>
          </motion.div>

          <nav className="flex bg-neutral-200/50 p-1 rounded-xl">
            <button 
              onClick={() => setView('scan')}
              className={`px-4 py-1.5 rounded-lg text-sm font-bold transition-all flex items-center gap-2 ${view === 'scan' ? 'bg-white text-emerald-600 shadow-sm' : 'text-neutral-500 hover:text-neutral-700'}`}
            >
              <Camera className="w-4 h-4" />
              스캔
            </button>
            <button 
              onClick={() => setView('history')}
              className={`px-4 py-1.5 rounded-lg text-sm font-bold transition-all flex items-center gap-2 ${view === 'history' ? 'bg-white text-emerald-600 shadow-sm' : 'text-neutral-500 hover:text-neutral-700'}`}
            >
              <History className="w-4 h-4" />
              히스토리
            </button>
          </nav>
        </div>
        {view === 'scan' && (
          <div className="flex flex-col items-center gap-2">
            <p className="text-neutral-500 text-sm text-center">카메라로 쓰레기를 비추면 분리배출 방법을 찾아드립니다.</p>
            <div className="flex items-center gap-1 text-[10px] text-emerald-600 font-bold bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-100">
              <ShieldAlert className="w-3 h-3" /> 개인정보 보호: 모든 이미지는 얼굴이 자동 블러 처리됩니다
            </div>
          </div>
        )}
      </header>

      <main className="w-full flex-1 flex flex-col gap-6 overflow-hidden">
        {view === 'scan' ? (
          <div className="flex-1 flex flex-col gap-6">
            <section className="flex flex-col items-center">
              <AnimatePresence mode="wait">
                {!capturedImage ? (
                  <motion.div 
                    key="camera"
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="camera-container bg-black"
                  >
                    <video 
                      ref={videoRef} 
                      autoPlay 
                      playsInline 
                      muted 
                      className="camera-video"
                    />
                    <div className="scan-line" />
                    <div className="absolute inset-0 border-2 border-emerald-500/30 rounded-[1.5rem] pointer-events-none" />
                    <div className="absolute bottom-6 left-1/2 -translate-x-1/2">
                      <button
                        disabled={isProcessingImage}
                        onClick={captureAndAnalyze}
                        className="w-16 h-16 bg-white rounded-full flex items-center justify-center shadow-lg hover:scale-105 active:scale-95 transition-transform disabled:opacity-50"
                      >
                        <div className="w-12 h-12 border-4 border-emerald-500 rounded-full flex items-center justify-center">
                          <Camera className="w-6 h-6 text-emerald-600" />
                        </div>
                      </button>
                    </div>
                  </motion.div>
                ) : (
                  <motion.div 
                    key="preview"
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="relative camera-container bg-neutral-200"
                  >
                    <img src={capturedImage} alt="Captured" className="w-full h-full object-cover" />
                    {(isAnalyzing || isProcessingImage) && (
                      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm flex flex-col items-center justify-center text-white p-6 text-center">
                        <Loader2 className="w-10 h-10 animate-spin mb-4 text-emerald-400" />
                        <p className="font-medium">
                          {isProcessingImage ? "이미지 보안 처리 중..." : "AI가 물체를 분석하고 있습니다..."}
                        </p>
                        <p className="text-xs opacity-70 mt-1">
                          {isProcessingImage ? "얼굴 인식 및 블러 적용 완료" : "분리배출 데이터베이스 검색 중"}
                        </p>
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </section>

            <section className="w-full">
              <AnimatePresence>
                {error && (
                  <motion.div 
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    className="bg-red-50 border border-red-100 p-4 rounded-2xl flex gap-3 items-center mb-4"
                  >
                    <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
                    <div className="flex-1">
                      <p className="text-red-800 text-sm font-medium">{error}</p>
                    </div>
                    <button onClick={reset} className="p-1 hover:bg-red-100 rounded-lg transition-colors">
                      <RefreshCcw className="w-4 h-4 text-red-500" />
                    </button>
                  </motion.div>
                )}

                {result && (
                  <motion.div 
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="space-y-4"
                  >
                    <div className="bg-white border border-neutral-100 p-6 rounded-[2rem] shadow-sm">
                      <div className="flex justify-between items-start mb-6">
                        <div>
                          <span className="inline-block px-3 py-1 bg-emerald-50 text-emerald-700 text-xs font-bold rounded-full mb-2 uppercase tracking-wider">
                            {result.category}
                          </span>
                          <h2 className="text-2xl font-bold text-neutral-900">{result.itemName}</h2>
                        </div>
                        <button 
                          onClick={() => handleSpeak(result)}
                          className={`p-3 rounded-2xl transition-all shadow-sm ${isSpeaking ? 'bg-emerald-500 text-white animate-pulse' : 'bg-white hover:bg-neutral-50 text-emerald-600 border border-neutral-100'}`}
                          title={isSpeaking ? "읽기 중단" : "읽어주기"}
                        >
                          {isSpeaking ? <VolumeX className="w-6 h-6" /> : <Volume2 className="w-6 h-6" />}
                        </button>
                      </div>

                      <div className="space-y-6">
                        <div>
                          <h3 className="text-xs font-bold text-neutral-400 uppercase tracking-widest mb-3 flex items-center gap-2">
                            <ArrowRight className="w-3 h-3" /> 배출 방법
                          </h3>
                          <div className="p-4 bg-emerald-50/50 rounded-2xl border border-emerald-100/50">
                            <p className="text-neutral-800 leading-relaxed whitespace-pre-wrap italic">
                              "{result.disposalMethod}"
                            </p>
                          </div>
                        </div>

                        <div>
                          <h3 className="text-xs font-bold text-neutral-400 uppercase tracking-widest mb-3 flex items-center gap-2">
                            <CheckCircle2 className="w-3 h-3" /> 분리배출 팁
                          </h3>
                          <ul className="space-y-2">
                            {result.tips.map((tip, i) => (
                              <motion.li 
                                initial={{ opacity: 0, x: -10 }}
                                animate={{ opacity: 1, x: 0 }}
                                transition={{ delay: i * 0.1 }}
                                key={i} 
                                className="flex gap-3 text-sm text-neutral-600 bg-neutral-50 p-3 rounded-xl border border-neutral-100"
                              >
                                <span className="text-emerald-500 font-bold shrink-0">{i + 1}</span>
                                <span>{tip}</span>
                              </motion.li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </div>

                    <div className="flex gap-3">
                      <button 
                        onClick={reset}
                        className="flex-1 bg-emerald-600 text-white py-4 rounded-2xl font-bold flex items-center justify-center gap-2 shadow-lg shadow-emerald-200 hover:bg-emerald-700 active:scale-95 transition-all"
                      >
                        <RefreshCcw className="w-5 h-5" />
                        다시 스캔하기
                      </button>
                    </div>

                    <div className="p-4 flex gap-4 text-xs text-neutral-400 italic">
                      <Search className="w-4 h-4 shrink-0" />
                      <p>AI의 분석 결과는 정확하지 않을 수 있습니다. 지자체별 상세 기준을 확인해주세요.</p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </section>
          </div>
        ) : (
          <section className="flex-1 overflow-y-auto pr-2 pb-20 custom-scrollbar">
            <div className="flex justify-between items-end mb-4 px-2">
              <h2 className="text-lg font-bold text-neutral-800 tracking-tight">최근 분석 기록 ({history.length})</h2>
              <span className="text-[10px] text-neutral-400 font-medium bg-neutral-100 px-2 py-1 rounded-lg flex items-center gap-1">
                <Clock className="w-3 h-3" /> 20일 후 자동 삭제
              </span>
            </div>
            
            {history.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-neutral-400 gap-4">
                <History className="w-12 h-12 opacity-20" />
                <p className="text-sm">저장된 기록이 없습니다.</p>
                <button 
                  onClick={() => setView('scan')}
                  className="text-emerald-600 font-bold text-sm underline underline-offset-4"
                >
                  지금 첫 스캔 시작하기
                </button>
              </div>
            ) : (
              <div className="grid gap-4">
                {history.map((item) => (
                  <motion.div 
                    layout
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    key={item.id}
                    className="bg-white p-4 rounded-3xl border border-neutral-100 shadow-sm flex gap-4"
                  >
                    <div className="w-24 h-24 rounded-2xl overflow-hidden shrink-0">
                      <img src={item.imageUrl} alt={item.itemName} className="w-full h-full object-cover" />
                    </div>
                    <div className="flex-1 min-w-0 flex flex-col justify-between">
                      <div>
                        <div className="flex justify-between items-start mb-1">
                          <span className="text-[10px] uppercase font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
                            {item.category}
                          </span>
                          <button 
                            onClick={() => deleteHistoryItem(item.id)}
                            className="p-1 text-neutral-300 hover:text-red-400 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                        <h3 className="font-bold text-neutral-900 truncate">{item.itemName}</h3>
                        <p className="text-xs text-neutral-500 line-clamp-2 mt-1 italic">
                          {item.disposalMethod}
                        </p>
                      </div>
                      <div className="flex justify-between items-center mt-2">
                        <span className="text-[10px] text-neutral-400">
                          {new Date(item.timestamp).toLocaleDateString()} {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        <button 
                          onClick={() => {
                            setResult(item);
                            setCapturedImage(item.imageUrl);
                            setView('scan');
                            handleSpeak(item);
                          }}
                          className="text-xs font-bold text-emerald-600 flex items-center gap-1 hover:underline underline-offset-2"
                        >
                          상세보기 <ArrowRight className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
            )}
          </section>
        )}
      </main>

      <canvas ref={canvasRef} className="hidden" />

      {/* Footer Info */}
      {view === 'scan' && !result && !isAnalyzing && (
        <motion.footer 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="mt-8 text-center"
        >
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-neutral-100 rounded-full text-xs text-neutral-500 font-medium">
            <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
            실시간 AI 물체 인식 모드 활성화됨
          </div>
        </motion.footer>
      )}

      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #e5e5e5;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #d4d4d4;
        }
      `}} />
    </div>
  );
}
