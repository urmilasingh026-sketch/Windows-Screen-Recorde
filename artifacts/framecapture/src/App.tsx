import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Clapperboard,
  Download,
  Folder,
  FolderOpen,
  HardDrive,
  Monitor,
  Pause,
  Play,
  RefreshCw,
  Square,
  Video,
  AppWindow,
} from 'lucide-react';
import { AnnotationCanvas, AnnotationToolbar, RecordingToolbar } from './components/AnnotationOverlay';

type Source = { id: string; name: string; type: 'screen' | 'window'; thumbnail: string; displayId?: string; width?: number; height?: number };
type Recording = { id: string; name: string; path: string; createdAt: string; size: number; duration: number };
type RecordingCommand = 'start' | 'pause' | 'resume' | 'stop';
type FrameCaptureBridge = {
  getSources(): Promise<Source[]>;
  selectSource(id: string): Promise<void>;
  getOutputDirectory(): Promise<string>;
  chooseOutputDirectory(): Promise<string | null>;
  listRecordings(): Promise<Recording[]>;
  revealRecording(path: string): Promise<void>;
  beginRecording(name: string): Promise<{ id: string }>;
  writeRecordingChunk(id: string, chunk: ArrayBuffer): Promise<void>;
  finishRecording(id: string, durationSeconds: number): Promise<Recording>;
  cancelRecording(id: string): Promise<void>;
  openAnnotationOverlay(sourceId: string): Promise<void>;
  closeAnnotationOverlay(): Promise<void>;
  onExportProgress(callback: (progress: number) => void): () => void;
  reportRecordingState(state: RecordState, elapsedSeconds: number, status: string, error: string): void;
  onRecordingControl(callback: (command: RecordingCommand) => void): () => void;
  rendererReady(): void;
};
declare global {
  interface Window { frameCapture?: FrameCaptureBridge }
}
type Mode = 'screen' | 'window';
type RecordState = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping';

const prettyTime = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
};
const prettySize = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const prettyDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
};

function App() {
  const bridge = typeof window !== 'undefined' ? window.frameCapture : undefined;
  const [mode, setMode] = useState<Mode>('screen');
  const [sources, setSources] = useState<Source[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [resolution, setResolution] = useState('1080p');
  const [fps, setFps] = useState('30');
  const [microphone, setMicrophone] = useState(false);
  const [systemAudio, setSystemAudio] = useState(true);
  const [annotationsEnabled, setAnnotationsEnabled] = useState(false);
  const [directory, setDirectory] = useState('Loading output location…');
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [state, setState] = useState<RecordState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState('Ready to capture');
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const activeStream = useRef<MediaStream | null>(null);
  const micStream = useRef<MediaStream | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const audioSources = useRef<MediaStreamAudioSourceNode[]>([]);
  const mixedAudioStream = useRef<MediaStream | null>(null);
  const recordingId = useRef('');
  const browserChunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const carryTime = useRef(0);
  const pendingWrites = useRef<Promise<void>[]>([]);
  const stoppingRef = useRef(false);
  const recordingLock = useRef(false);
  const startRecordingRef = useRef<(fromToolbox?: boolean) => Promise<void>>(async () => undefined);
  const chunkWriteFailed = useRef(false);
  const elapsedSeconds = Math.floor(elapsed);

  const refreshRecordings = useCallback(async () => {
    if (!bridge) return;
    try { setRecordings(await bridge.listRecordings()); } catch { setRecordings([]); }
  }, [bridge]);

  const loadSources = useCallback(async () => {
    if (!bridge) return;
    setRefreshing(true);
    try {
      const available = await bridge.getSources();
      setSources(available);
      const initialSource = available.find((source) => source.type === 'screen') ?? available[0];
      setSelectedId(initialSource?.id ?? '');
      if (initialSource) await bridge.selectSource(initialSource.id);
      setError('');
    } catch {
      setError('Capture sources could not be loaded. Check the desktop capture permissions and try again.');
    } finally { setRefreshing(false); }
  }, [bridge]);

  useEffect(() => {
    if (!bridge) {
      setDirectory('Browser preview · downloads folder');
      setSources([
        { id: 'preview-monitor', name: 'Entire display', type: 'screen', thumbnail: '' },
        { id: 'preview-app', name: 'Choose a window', type: 'window', thumbnail: '' },
      ]);
      setSelectedId('preview-monitor');
      return;
    }
    void loadSources();
    void refreshRecordings();
    void bridge.getOutputDirectory().then(setDirectory).catch(() => setDirectory('Output folder unavailable'));
  }, [bridge, loadSources, refreshRecordings]);

  useEffect(() => {
    if (state !== 'recording') return;
    const timer = window.setInterval(() => setElapsed(carryTime.current + Math.floor((Date.now() - startedAt.current) / 1000)), 250);
    return () => window.clearInterval(timer);
  }, [state]);

  useEffect(() => {
    if (!bridge) return;
    bridge.reportRecordingState(state, elapsedSeconds, status, error);
  }, [bridge, state, elapsedSeconds, status, error]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.onExportProgress((progress) => setStatus(`Finalizing recording · ${Math.round(progress)}%`));
  }, [bridge]);

  const selectMode = async (next: Mode) => {
    setMode(next);
    if (next !== 'screen') setAnnotationsEnabled(false);
    const matching = sources.find((source) => source.type === next);
    if (matching) {
      setSelectedId(matching.id);
      if (bridge) {
        try { await bridge.selectSource(matching.id); } catch { setError('Could not select that capture source.'); }
      }
    }
  };

  const selectSource = async (source: Source) => {
    setSelectedId(source.id);
    setMode(source.type);
    if (source.type !== 'screen') setAnnotationsEnabled(false);
    setError('');
    if (bridge) {
      try { await bridge.selectSource(source.id); setStatus(`${source.name} selected`); }
      catch { setError('Could not select that capture source.'); }
    } else setStatus(`${source.name} ready · the browser will ask you to confirm a source when recording starts`);
  };

  const chooseFolder = async () => {
    if (!bridge) {
      setStatus('Browser preview saves recordings to your browser’s Downloads folder.');
      return;
    }
    try {
      const chosen = await bridge.chooseOutputDirectory();
      if (chosen) { setDirectory(chosen); setStatus('Output folder updated'); }
    } catch { setError('The output folder could not be changed.'); }
  };

  const stopTracks = () => {
    activeStream.current?.getTracks().forEach((track) => track.stop());
    micStream.current?.getTracks().forEach((track) => track.stop());
    mixedAudioStream.current?.getTracks().forEach((track) => track.stop());
    audioSources.current.forEach((source) => {
      try { source.disconnect(); } catch { /* already disconnected */ }
    });
    audioSources.current = [];
    mixedAudioStream.current = null;
    activeStream.current = null;
    micStream.current = null;
  };

  const saveBrowserRecording = (blob: Blob, name: string, duration: number) => {
    const extension = blob.type.toLowerCase().includes('mp4') ? 'mp4' : 'webm';
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${name}.${extension}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    const item: Recording = {
      id: `local-${Date.now()}`, name: `${name}.${extension}`, path: 'Downloads',
      createdAt: new Date().toISOString(), size: blob.size, duration,
    };
    setRecordings((current) => [item, ...current]);
  };

  const startRecording = async (fromToolbox = false) => {
    if (recordingLock.current) return;
    recordingLock.current = true;
    setState('starting');
    setError('');
    setStatus(fromToolbox ? 'Starting from the floating toolbox…' : 'Preparing capture…');
    if (
      !navigator.mediaDevices ||
      (fromToolbox && !navigator.mediaDevices.getUserMedia) ||
      (!fromToolbox && !navigator.mediaDevices.getDisplayMedia)
    ) {
      setError('Screen capture is unavailable in this browser. Open FrameCapture on a supported desktop browser.');
      setState('idle');
      recordingLock.current = false;
      return;
    }
    if (annotationsEnabled && (!bridge || mode !== 'screen')) {
      setError('On-screen drawing is available in the Windows desktop app when recording a screen.');
      setState('idle');
      recordingLock.current = false;
      return;
    }
    let annotationOverlayOpened = false;
    try {
      let captureSourceId = selectedId;
      if (bridge && fromToolbox && !captureSourceId) {
        const available = await bridge.getSources();
        const initialSource = available.find((source) => source.type === 'screen') ?? available[0];
        if (!initialSource) throw new Error('No screen or window is available to record.');
        captureSourceId = initialSource.id;
        setSources(available);
        setSelectedId(initialSource.id);
        await bridge.selectSource(initialSource.id);
      }
      if (fromToolbox && bridge && !captureSourceId) {
        throw new Error('Choose a capture source in FrameCapture before starting from the toolbox.');
      }
      if (annotationsEnabled && bridge) {
        await bridge.openAnnotationOverlay(captureSourceId);
        annotationOverlayOpened = true;
      }
      setStatus(fromToolbox ? 'Connecting to the selected screen…' : 'Choose a screen or window in the capture prompt…');
      const quality = resolution === '4K' ? { width: 3840, height: 2160 } : resolution === '1440p' ? { width: 2560, height: 1440 } : { width: 1920, height: 1080 };
      const targetFps = Number(fps);
      let display: MediaStream;
      if (bridge && fromToolbox) {
        const desktopVideo = {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: captureSourceId,
            maxWidth: quality.width,
            maxHeight: quality.height,
            maxFrameRate: targetFps,
          },
        } as unknown as MediaTrackConstraints;
        const desktopAudio = systemAudio
          ? ({
              mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: captureSourceId,
              },
            } as unknown as MediaTrackConstraints)
          : false;
        try {
          display = await navigator.mediaDevices.getUserMedia({
            video: desktopVideo,
            audio: desktopAudio,
          });
        } catch (captureError) {
          if (!systemAudio) throw captureError;
          const detail = captureError instanceof Error ? ` ${captureError.message}` : '';
          setError(`System audio could not start. Retrying screen capture without system audio.${detail}`);
          display = await navigator.mediaDevices.getUserMedia({
            video: desktopVideo,
            audio: false,
          });
        }
      } else {
        display = await navigator.mediaDevices.getDisplayMedia({
            video: {
              width: { ideal: quality.width, max: quality.width },
              height: { ideal: quality.height, max: quality.height },
              frameRate: { ideal: targetFps, max: targetFps },
            },
            audio: systemAudio,
          });
      }
      activeStream.current = display;
      const videoTrack = display.getVideoTracks()[0];
      if (videoTrack) videoTrack.contentHint = 'detail';
      const captureSettings = videoTrack?.getSettings();
      const capturedWidth = captureSettings?.width;
      const capturedHeight = captureSettings?.height;
      const actualFps = captureSettings?.frameRate;
      const capturedSize = capturedWidth && capturedHeight
        ? `${capturedWidth} × ${capturedHeight}`
        : `${resolution} requested`;
      const capturedFps = typeof actualFps === 'number' && actualFps > 0
        ? `${Math.round(actualFps)} FPS`
        : `${targetFps} FPS requested`;
      const captureSummary = `${capturedSize} · ${typeof actualFps === 'number' && actualFps > 0 ? `${actualFps.toFixed(1)} FPS` : `${targetFps} FPS requested`}`;
      const captureLimited =
        (Boolean(capturedWidth && capturedHeight) &&
          (capturedWidth! < quality.width || capturedHeight! < quality.height)) ||
        (typeof actualFps === 'number' && actualFps + 2 < targetFps);
      if (microphone) {
        try {
          micStream.current = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          });
        } catch {
          setError('Screen capture started, but microphone access was denied. Recording will continue without microphone audio.');
        }
      }
      const systemAudioTracks = display.getAudioTracks();
      const microphoneTracks = micStream.current?.getAudioTracks() ?? [];
      if (systemAudio && systemAudioTracks.length === 0) {
        setError('System audio was not provided by the selected source. Check Windows audio capture permissions and try again.');
      }
      const audioTracks = [...systemAudioTracks, ...microphoneTracks];
      const combined = new MediaStream(display.getVideoTracks());
      if (audioTracks.length === 1) {
        combined.addTrack(audioTracks[0]);
      } else if (audioTracks.length > 1) {
        const context = audioContext.current ?? new AudioContext();
        audioContext.current = context;
        if (context.state === 'suspended') {
          try { await context.resume(); } catch { /* fall back to a single audio input below */ }
        }
        if (context.state !== 'running') {
          combined.addTrack(microphoneTracks[0] ?? systemAudioTracks[0]);
          setError('Microphone and system audio could not be mixed. Recording one available audio source instead.');
        } else {
          const destination = context.createMediaStreamDestination();
        for (const track of audioTracks) {
          const source = context.createMediaStreamSource(new MediaStream([track]));
          source.connect(destination);
          audioSources.current.push(source);
        }
          mixedAudioStream.current = destination.stream;
          destination.stream.getAudioTracks().forEach((track) => combined.addTrack(track));
        }
      }
      const requestedName = `Capture ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).replace(':', '-')}`;
      let id = '';
      if (bridge) {
        const begun = await bridge.beginRecording(requestedName);
        id = begun.id;
        recordingId.current = id;
      } else browserChunks.current = [];
      const browserMp4Types = bridge ? [] : [
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4;codecs=avc1',
        'video/mp4',
      ];
      const preferred = [
        ...browserMp4Types,
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
      ].find((type) => MediaRecorder.isTypeSupported(type));
      const videoBitsPerSecond = resolution === '4K'
        ? (targetFps >= 60 ? 40_000_000 : 26_000_000)
        : resolution === '1440p'
          ? (targetFps >= 60 ? 24_000_000 : 16_000_000)
          : (targetFps >= 60 ? 14_000_000 : 8_000_000);
      const recorderOptions: MediaRecorderOptions = {
        ...(preferred ? { mimeType: preferred } : {}),
        videoBitsPerSecond,
        ...(audioTracks.length ? { audioBitsPerSecond: 192_000 } : {}),
      };
      const recorder = new MediaRecorder(combined, recorderOptions);
      mediaRecorder.current = recorder;
      pendingWrites.current = [];
      chunkWriteFailed.current = false;
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        if (!bridge) { browserChunks.current.push(event.data); return; }
        const write = event.data.arrayBuffer().then((buffer) => bridge.writeRecordingChunk(id, buffer)).catch(() => {
          chunkWriteFailed.current = true;
          setError('A recording segment could not be saved. Stop the capture and check available disk space.');
          if (!stoppingRef.current) void stopRecording();
        });
        pendingWrites.current.push(write);
      };
      recorder.onerror = () => setError('Recording encountered an unexpected capture error.');
      recorder.onstop = async () => {
        if (annotationOverlayOpened && bridge) {
          await bridge.closeAnnotationOverlay().catch(() => undefined);
          annotationOverlayOpened = false;
        }
        try {
          if (bridge && recordingId.current) {
            await Promise.all(pendingWrites.current);
            if (chunkWriteFailed.current) throw new Error('A recording segment could not be saved.');
            const saved = await bridge.finishRecording(recordingId.current, carryTime.current);
            setRecordings((current) => [saved, ...current.filter((entry) => entry.id !== saved.id)]);
            setStatus('Recording saved');
          } else {
            const blob = new Blob(browserChunks.current, { type: recorder.mimeType || 'video/webm' });
            saveBrowserRecording(blob, requestedName, carryTime.current);
            setStatus(blob.type.toLowerCase().includes('mp4')
              ? 'MP4 downloaded to your browser’s Downloads folder'
              : 'This browser cannot record MP4; WebM downloaded to your browser’s Downloads folder');
          }
        } catch {
          setError('The recording could not be finalized. Check the output location and available disk space.');
          if (bridge && recordingId.current) await bridge.cancelRecording(recordingId.current).catch(() => undefined);
        } finally {
          recordingId.current = '';
          stopTracks();
          mediaRecorder.current = null;
          setState('idle');
          stoppingRef.current = false;
            recordingLock.current = false;
        }
      };
      display.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (!stoppingRef.current && mediaRecorder.current?.state !== 'inactive') void stopRecording();
      });
      carryTime.current = 0;
      startedAt.current = Date.now();
      setElapsed(0);
      recorder.start(2500);
      setState('recording');
      const captureStatus = `${bridge ? 'Recording' : 'Browser preview'} · Captured ${captureSummary} · Target ${resolution} at ${targetFps} FPS${captureLimited ? ' · display or PC limit' : ''}`;
      setStatus(captureStatus);
    } catch (problem) {
      if (annotationOverlayOpened && bridge) {
        await bridge.closeAnnotationOverlay().catch(() => undefined);
      }
      stopTracks();
      setState('idle');
      recordingLock.current = false;
      if (problem instanceof DOMException && problem.name === 'NotAllowedError') {
        setStatus('Capture was cancelled');
      } else {
        setError(problem instanceof Error ? problem.message : 'Could not start recording. Check your capture settings and try again.');
      }
      if (bridge && recordingId.current) {
        await bridge.cancelRecording(recordingId.current).catch(() => undefined);
        recordingId.current = '';
      }
      recordingLock.current = false;
    }
  };
  startRecordingRef.current = startRecording;

  const pauseRecording = useCallback(() => {
    const recorder = mediaRecorder.current;
    if (!recorder || recorder.state !== 'recording') return;
    recorder.pause();
    carryTime.current += Math.floor((Date.now() - startedAt.current) / 1000);
    setElapsed(carryTime.current);
    setState('paused');
    setStatus('Recording paused');
  }, []);
  const resumeRecording = useCallback(() => {
    const recorder = mediaRecorder.current;
    if (!recorder || recorder.state !== 'paused') return;
    recorder.resume();
    startedAt.current = Date.now();
    setState('recording');
    setStatus(bridge ? 'Recording to your selected output folder' : 'Recording · browser preview WebM capture');
  }, [bridge]);
  const stopRecording = useCallback(async () => {
    const recorder = mediaRecorder.current;
    if (!recorder || recorder.state === 'inactive') return;
    if (recorder.state === 'recording') {
      carryTime.current += Math.floor((Date.now() - startedAt.current) / 1000);
      setElapsed(carryTime.current);
    }
    stoppingRef.current = true;
    setState('stopping');
    setStatus('Finishing recording…');
    recorder.stop();
  }, []);

  useEffect(() => {
    if (!bridge) return;
    return bridge.onRecordingControl((command) => {
      if (command === 'start') void startRecordingRef.current(true);
      else if (command === 'pause') pauseRecording();
      else if (command === 'resume') resumeRecording();
      else if (command === 'stop') void stopRecording();
    });
  }, [bridge, pauseRecording, resumeRecording, stopRecording]);

  useEffect(() => {
    if (!bridge) return;
    bridge.rendererReady();
  }, [bridge]);

  const reveal = async (item: Recording) => {
    if (bridge) {
      try { await bridge.revealRecording(item.path); }
      catch { setError('Could not open this recording in File Explorer.'); }
      return;
    }
    setStatus('Browser preview files are saved to your Downloads folder.');
  };

  const visibleSources = sources.filter((source) => source.type === mode);
  const selectedSource = sources.find((source) => source.id === selectedId);
  const canAnnotate = Boolean(bridge && selectedSource?.type === 'screen');
  const targetDimensions = resolution === '4K'
    ? { width: 3840, height: 2160 }
    : resolution === '1440p'
      ? { width: 2560, height: 1440 }
      : { width: 1920, height: 1080 };
  const selectedDisplayBelowTarget = Boolean(
    selectedSource?.type === 'screen' &&
    selectedSource.width &&
    selectedSource.height &&
    (selectedSource.width < targetDimensions.width ||
      selectedSource.height < targetDimensions.height),
  );
  const active = state === 'starting' || state === 'recording' || state === 'paused' || state === 'stopping';

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand" data-testid="brand-framecapture">
          <span className="brand-mark"><Clapperboard aria-hidden="true" /></span>
          <span>FrameCapture</span>
        </div>
        <div className="top-meta">
          <span><i className="status-led" />{bridge ? 'Capture engine ready' : 'Browser capture preview'}</span>
          <span>{bridge ? 'LOCAL · MP4' : 'BROWSER · MP4 IF SUPPORTED'}</span>
          {import.meta.env.DEV && (
            <a
              className="download-app-link"
              href="/download/windows-app"
              aria-label="Download the FrameCapture Windows installer"
              title="Download the FrameCapture Windows installer"
              data-testid="link-download-windows-app"
            >
              <Download aria-hidden="true" size={14} />
              <span className="download-app-label">Install for Windows</span>
            </a>
          )}
        </div>
      </header>
      <main className="main-wrap">
        <div className="page-intro">
          <div>
            <div className="eyebrow">Recording workspace / 01</div>
            <h1>Make the moment clear.</h1>
            <p className="intro-copy">Choose what to capture. We’ll take care of the rest.</p>
          </div>
          {!bridge && <div className="preview-badge" data-testid="status-browser-preview">BROWSER PREVIEW · MP4 IF SUPPORTED</div>}
        </div>

        <div className="workspace">
          <section className="panel source-panel" aria-labelledby="source-title">
            <div className="section-head">
              <h2 className="section-title" id="source-title"><span className="step-num">01</span> Choose a capture source</h2>
              {bridge && <button className="subtle-link" type="button" onClick={() => void loadSources()} disabled={refreshing} data-testid="button-refresh-sources">
                <RefreshCw size={12} /> {refreshing ? 'Scanning…' : 'Refresh sources'}
              </button>}
            </div>
            <div className="source-tabs" role="tablist" aria-label="Capture source type">
              <button className={`tab-button ${mode === 'screen' ? 'active' : ''}`} onClick={() => void selectMode('screen')} role="tab" aria-selected={mode === 'screen'} data-testid="tab-screen"><Monitor size={13} /> Screen</button>
              <button className={`tab-button ${mode === 'window' ? 'active' : ''}`} onClick={() => void selectMode('window')} role="tab" aria-selected={mode === 'window'} data-testid="tab-window"><AppWindow size={13} /> App window</button>
            </div>
            {visibleSources.length ? <div className="source-grid" data-testid="list-capture-sources">
              {visibleSources.map((source) => (
                <button type="button" className={`source-card ${selectedId === source.id ? 'selected' : ''}`} key={source.id} onClick={() => void selectSource(source)} data-testid={`source-card-${source.id}`}>
                  <div className="source-thumb">
                    {source.thumbnail ? <img src={source.thumbnail} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <div className={source.type === 'screen' ? 'thumb-desktop' : 'thumb-window'} />}
                    {selectedId === source.id && <span className="selected-check" style={{ position: 'absolute', right: 9, top: 9, width: 22, height: 22, background: '#faf9f3', borderRadius: 20, display: 'grid', placeItems: 'center' }}><Check size={13} /></span>}
                  </div>
                  <div className="source-info"><span className="source-name">{source.name}</span><span className="source-detail">{source.type === 'screen' && source.width && source.height ? `${source.width} × ${source.height}` : source.type === 'screen' ? 'DISPLAY' : 'WINDOW'}</span></div>
                </button>
              ))}
            </div> : <div className="empty-sources" data-testid="empty-capture-sources">{refreshing ? 'Scanning for available displays and windows…' : 'No sources found for this category. Refresh to scan again.'}</div>}
            {!bridge && <p className="browser-note" data-testid="text-preview-source-note"><strong>Preview mode:</strong> source tiles set your intent; the browser’s native picker lets you confirm the actual screen or window when recording begins.</p>}
          </section>

          <aside className="capture-column">
            <section className="panel settings-panel" aria-labelledby="settings-title">
              <h2 className="section-title settings-title" id="settings-title"><span className="step-num">02</span> Capture settings</h2>
              <div className="form-row">
                <label className="field-label" htmlFor="resolution">Resolution</label>
                <div style={{ position: 'relative' }}><select id="resolution" className="select-control" value={resolution} onChange={(event) => setResolution(event.target.value)} data-testid="select-resolution">
                  <option value="1080p">1080p · Full HD</option><option value="1440p">1440p · QHD</option><option value="4K">4K · Ultra HD</option>
                </select><ChevronDown size={12} style={{ position: 'absolute', right: 9, top: 11, pointerEvents: 'none', color: '#707970' }} /></div>
              </div>
              {selectedDisplayBelowTarget && selectedSource?.width && selectedSource.height && (
                <div className="resolution-warning" role="status">
                  This display is {selectedSource.width} × {selectedSource.height}; it cannot provide native {resolution} capture.
                </div>
              )}
              <div className="form-row">
                <label className="field-label" htmlFor="frame-rate">Frame rate</label>
                <div style={{ position: 'relative' }}><select id="frame-rate" className="select-control" value={fps} onChange={(event) => setFps(event.target.value)} data-testid="select-frame-rate">
                  <option value="30">30 FPS · Standard</option><option value="60">60 FPS · Smooth</option>
                </select><ChevronDown size={12} style={{ position: 'absolute', right: 9, top: 11, pointerEvents: 'none', color: '#707970' }} /></div>
              </div>
              <div className="divider" />
              <div className="toggle-row">
                <div className="toggle-copy">Microphone <small>Include your voice</small></div>
                <button type="button" role="switch" aria-checked={microphone} className={`switch ${microphone ? 'on' : ''}`} onClick={() => {
                  const enabled = !microphone;
                  setMicrophone(enabled);
                  if (enabled) {
                    try {
                      const context = audioContext.current ?? new AudioContext();
                      audioContext.current = context;
                      if (context.state === 'suspended') void context.resume().catch(() => undefined);
                    } catch { setError('The browser could not prepare microphone audio mixing.'); }
                  }
                }} data-testid="toggle-microphone"><span className="switch-thumb" /></button>
              </div>
              <div className="toggle-row">
                <div className="toggle-copy">System audio <small>Capture audio from the source</small></div>
                <button type="button" role="switch" aria-checked={systemAudio} className={`switch ${systemAudio ? 'on' : ''}`} onClick={() => setSystemAudio(!systemAudio)} data-testid="toggle-system-audio"><span className="switch-thumb" /></button>
              </div>
              <div className="toggle-row annotation-setting">
                <div className="toggle-copy">Draw on screen <small>{canAnnotate ? 'Show annotation tools while recording' : 'Windows desktop app · screen capture only'}</small></div>
                <button type="button" role="switch" aria-checked={annotationsEnabled} aria-label="Draw on screen" className={`switch ${annotationsEnabled ? 'on' : ''}`} onClick={() => setAnnotationsEnabled(!annotationsEnabled)} disabled={!canAnnotate || active} data-testid="toggle-screen-annotations"><span className="switch-thumb" /></button>
              </div>
              <div className="capability-note" data-testid="note-hardware-capability"><AlertTriangle size={14} /><span>Resolution and FPS are capture targets. The status line shows what the display and PC actually provide.</span></div>
            </section>
            <section className="panel output-panel">
              <div className="section-head"><h2 className="section-title"><span className="step-num">03</span> Save location</h2></div>
              <div className="output-row">
                <span className="output-path" title={directory} data-testid="text-output-directory"><Folder size={13} style={{ verticalAlign: 'middle', marginRight: 7 }} />{directory}</span>
                <button type="button" className="icon-button" onClick={() => void chooseFolder()} aria-label="Choose output folder" title="Choose output folder" data-testid="button-choose-output"><FolderOpen size={15} /></button>
              </div>
            </section>
          </aside>
        </div>

        <section className="control-panel" aria-label="Recording controls">
          <div className="record-state">
            <span className={`record-indicator ${state === 'recording' ? 'recording' : ''}`}>{state === 'recording' ? <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'currentColor' }} /> : <Video size={17} />}</span>
            <div className="record-copy"><strong data-testid="status-recording-state">{state === 'starting' ? 'Starting capture…' : state === 'recording' ? 'Recording in progress' : state === 'paused' ? 'Recording paused' : state === 'stopping' ? 'Saving your capture' : 'Ready when you are'}</strong>
              <span data-testid="text-recording-timer">{prettyTime(elapsed)}{state === 'recording' ? '  ·  REC' : ''}</span></div>
          </div>
          <div className="record-buttons">
            {!active && <button type="button" className="primary-button" onClick={() => void startRecording()} disabled={!selectedId && !!bridge} data-testid="button-start-recording"><Play size={14} fill="currentColor" /> Start recording</button>}
            {state === 'starting' && <button type="button" className="secondary-button" disabled data-testid="button-starting-recording"><RefreshCw size={13} /> Starting…</button>}
            {(state === 'idle' || state === 'recording') && <button type="button" className="secondary-button" onClick={pauseRecording} disabled={state !== 'recording'} data-testid="button-pause-recording"><Pause size={14} fill="currentColor" /> Pause</button>}
            {state === 'paused' && <button type="button" className="primary-button" onClick={resumeRecording} data-testid="button-resume-recording"><Play size={14} fill="currentColor" /> Resume</button>}
            {(state === 'recording' || state === 'paused') && <button type="button" className="danger-button" onClick={() => void stopRecording()} data-testid="button-stop-recording"><Square size={13} fill="currentColor" /> Stop</button>}
            {state === 'stopping' && <button type="button" className="secondary-button" disabled data-testid="button-saving-recording"><RefreshCw size={13} /> Saving…</button>}
          </div>
          <div className={`status-line ${error ? 'error' : ''}`} data-testid="status-message"><span className="status-led" style={error ? { background: '#ae5148', boxShadow: '0 0 0 3px #f0d9d2' } : undefined} />{error || status}</div>
        </section>

        <section className="recent-section" aria-labelledby="recent-title">
          <div className="recent-heading"><h2 id="recent-title">Recent recordings</h2><span data-testid="text-recording-count">{recordings.length ? `${recordings.length} ${recordings.length === 1 ? 'FILE' : 'FILES'}` : 'LOCAL LIBRARY'}</span></div>
          <div className="recent-list" data-testid="list-recent-recordings">
            {recordings.length ? recordings.slice(0, 5).map((item) => (
              <div className="recording-item" key={item.id} data-testid={`recording-row-${item.id}`}>
                <span className="file-icon"><Video size={15} /></span>
                <div style={{ minWidth: 0 }}><div className="file-name" title={item.name}>{item.name}</div><div className="file-date">{prettyDate(item.createdAt)} · {prettyTime(item.duration)}</div></div>
                <span className="file-meta">{prettySize(item.size)}</span>
                <button type="button" className="icon-button" aria-label={`Show ${item.name} in folder`} title="Show in folder" onClick={() => void reveal(item)} data-testid={`button-reveal-${item.id}`}><FolderOpen size={14} /></button>
              </div>
            )) : <div className="empty-recent" data-testid="empty-recent-recordings"><span className="empty-recent-icon"><HardDrive size={15} /></span><span>Your recordings will appear here after your first capture.</span></div>}
          </div>
        </section>
      </main>
    </div>
  );
}

function AnnotationWindow({ surface }: { surface: 'canvas' | 'toolbar' }) {
  return surface === 'canvas'
    ? <AnnotationCanvas />
    : <div className="annotation-toolbar-window"><AnnotationToolbar /></div>;
}

export default function AppEntry() {
  if (window.location.hash === '#annotation-canvas') return <AnnotationWindow surface="canvas" />;
  if (window.location.hash === '#annotation-toolbar') return <AnnotationWindow surface="toolbar" />;
  if (window.location.hash === '#recording-toolbar') return <RecordingToolbar />;
  return <App />;
}
