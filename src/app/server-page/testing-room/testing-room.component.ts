import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  ViewChildren,
  QueryList
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { UsersService } from '../../services/users.service';
import { AuthService } from '../../services/auth.service';
import { SocketService } from '../../services/socket.service';
import { ServersService } from '../../services/servers.service';
import { ElectronService } from '../../services/electron.service';
import api from '../../services/api.service';

interface PeerConnection {
  pc: RTCPeerConnection;
  streams: {
    audio?: MediaStreamTrack;
    screen?: MediaStreamTrack;
    camera?: MediaStreamTrack;
  };
  displayName: string;
  retryCount: number;
  lastConnectionAttempt: number;
  lastOfferSent: number;
  isPolite: boolean;
  wasConnected: boolean;
  connectionTimeout: any;
  reconnectTimer: any;
  lastCandidate: string | null;
  pendingMetadata: { trackId: string; streamType: 'screen' | 'camera' }[];
}

interface ActiveWindow {
  userId: number;
  windowTitle: string;
  timestamp: number;
}

interface StreamTypeMap {
  stream: MediaStream;
  type: 'audio' | 'screen' | 'camera' | 'combined';
}

@Component({
  selector: 'app-testing-room',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './testing-room.component.html',
  styleUrls: ['./testing-room.component.scss']
})
export class TestingRoomComponent implements OnInit, OnDestroy {
  @ViewChild('localVideo', { static: false }) localVideoRef!: ElementRef<HTMLVideoElement>;
  @ViewChild('audioContainer', { static: false }) audioContainerRef!: ElementRef<HTMLDivElement>;
  @ViewChildren('remoteVideoContainer') remoteVideoContainers!: QueryList<ElementRef<HTMLDivElement>>;

  roomId: number = 15;
  userId: string = this.authService.getUser().id;
  isAdmin: boolean = this.serverService.currentServer().access_level > 0;

  users: any[] = [];
  testUserIds: Set<number> = new Set();
  activeWindows: ActiveWindow[] = [];

  localStream?: MediaStream;
  screenStream?: MediaStream;
  cameraStream?: MediaStream;

  peerConnections = new Map<number, PeerConnection>();
  remoteStreams = new Map<number, { screen?: MediaStream; camera?: MediaStream }>();
  pendingCandidates = new Map<number, RTCIceCandidate[]>();
  private streamTypeMap = new Map<MediaStream, StreamTypeMap>();
  private trackTypeMap = new Map<string, 'screen' | 'camera'>(); // Map track IDs to types
  private pendingTracks = new Map<number, { track: MediaStreamTrack; stream: MediaStream }[]>(); // Buffer tracks until metadata arrives

  isInTest = false;
  isTestStarted = false;
  isScreenSharing = false;
  isCameraEnabled = false;
  isMicMuted = false;

  private changeDetectionTimeout: any;
  private negotiationLock = new Map<number, boolean>();
  private windowCheckInterval: any;
  private readonly MAX_RETRIES = 2;
  private readonly BASE_RETRY_DELAY = 1000;
  private readonly ICE_CONNECTION_TIMEOUT = 5000; // Increased to prevent premature timeouts
  private readonly OFFER_COOLDOWN = 3000;
  private readonly INITIAL_CONNECTION_DELAY = 1000;
  private readonly MAX_PARALLEL_CONNECTIONS = 1;

  private activeConnectionCount = 0;

  constructor(
    private userService: UsersService,
    private authService: AuthService,
    private socketService: SocketService,
    private serverService: ServersService,
    private electronService: ElectronService,
    private cdr: ChangeDetectorRef
  ) {}

  async ngOnInit() {
    console.log('[Init] Initializing testing room component');
    await this.fetchInitialUsers();
    this.setupSocketListeners();
    this.socketService.joinAudioRoom(this.roomId.toString());
    this.startWindowTracking();
  }

  ngOnDestroy() {
    console.log('[Destroy] Cleaning up testing room component');
    this.leaveTest();
    if (this.changeDetectionTimeout) clearTimeout(this.changeDetectionTimeout);
    if (this.windowCheckInterval) clearInterval(this.windowCheckInterval);
  }

  private async fetchInitialUsers() {
    try {
      const res = await api.get(`http://lamzaone.go.ro:8000/api/room/${this.roomId}/users`);
      this.users = await Promise.all(
        res.data.userIds.map(async (id: string) => {
          const user = await this.userService.getUserInfo(id);
          const user_access_level_res = await api.get(
            `http://lamzaone.go.ro:8000/api/server/${this.serverService.currentServer().id}/user/${id}/access_level`
          );
          console.log(`[Init] Fetched user ${id}:`, user, ' access level:', user_access_level_res.data.access_level);
          return { ...user, id: parseInt(id), isAdmin: user_access_level_res.data.access_level > 0 };
        })
      );
      console.log('[Init] Users fetched:', this.users);
      this.testUserIds = new Set(this.users.map(u => u.id));
      this.debounceChangeDetection();
    } catch (error) {
      console.error('[Init] Failed to fetch users', error);
    }
  }

  async joinTestRoom() {
    if (this.isInTest) return;
    console.log('[Test] Joining test room');
    try {
      const mediaPromise = navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });

      this.isInTest = true;
      this.socketService.sendMessage(`user_joined_call:&${this.userId}`, false, 'audioRoom');
      this.testUserIds.add(parseInt(this.userId));

      this.localStream = await mediaPromise;
      this.streamTypeMap.set(this.localStream, { stream: this.localStream, type: 'audio' });
      if (this.localVideoRef?.nativeElement) {
        this.localVideoRef.nativeElement.srcObject = this.localStream;
        this.localVideoRef.nativeElement.muted = true;
        this.safePlayVideo(this.localVideoRef.nativeElement);
      }

      // Create connections to all users for audio
      this.users.forEach((user, index) => {
        if (user.id !== parseInt(this.userId)) {
          setTimeout(() => {
            if (this.isInTest && this.testUserIds.has(user.id)) {
              this.createPeerConnection(user.id);
            }
          }, index * 100);
        }
      });

      if (this.isTestStarted && !this.isAdmin) {
        await this.startScreenShare();
      }

      this.debounceChangeDetection();
    } catch (err) {
      console.error('[Test] Failed to join test room:', err);
      this.isInTest = false;
      alert('Failed to access microphone.');
      this.debounceChangeDetection();
    }
  }

  private setupSocketListeners() {
    console.log('[Socket] Setting up socket listeners');
    this.socketService.onAudioRoomMessage((message: string) => {
      if (message.startsWith('user_joined_call')) {
        const userId = parseInt(message.split(':&')[1]);
        if (!isNaN(userId)) this.handleUserJoined(userId);
      } else if (message.startsWith('user_left_call')) {
        const userId = parseInt(message.split(':&')[1]);
        if (!isNaN(userId)) this.handleUserLeft(userId);
      } else if (message.startsWith('test_started')) {
        this.handleTestStarted();
      } else if (message.startsWith('window_update')) {
        const parts = message.split(':&');
        if (parts.length === 3) {
          this.handleWindowUpdate(parseInt(parts[1]), parts[2]);
        }
      } else {
        try {
          const data = JSON.parse(message);
          if (data.type === 'ice-candidate' || data.type === 'offer' || data.type === 'answer' || data.type === 'track-metadata') {
            this.handleSignalingData(data);
          }
        } catch {
          console.log('[Socket] Non-JSON message:', message);
        }
      }
      this.debounceChangeDetection();
    });
  }

  private async handleUserJoined(userId: number) {
    if (!this.testUserIds.has(userId) && userId !== parseInt(this.userId)) {
      console.log(`[User] User ${userId} joined test`);
      this.testUserIds.add(userId);
      try {
        const user = await this.userService.getUserInfo(userId.toString());
        const user_access_level_res = await api.get(
          `http://lamzaone.go.ro:8000/api/server/${this.serverService.currentServer().id}/user/${userId}/access_level`
        );
        const userData = {
          ...user,
          id: userId,
          isAdmin: user_access_level_res.data.access_level > 0
        };
        if (!this.users.find(u => u.id === userId)) {
          this.users.push(userData);
        }
      } catch (error) {
        console.error(`[User] Failed to fetch info for user ${userId}`, error);
        if (!this.users.find(u => u.id === userId)) {
          this.users.push({ id: userId, name: `User ${userId}`, picture: '', isAdmin: false });
        }
      }
      if (this.isInTest) {
        const delay = this.activeConnectionCount < this.MAX_PARALLEL_CONNECTIONS
          ? this.INITIAL_CONNECTION_DELAY
          : this.INITIAL_CONNECTION_DELAY + Math.random() * 1000;
        setTimeout(() => {
          if (this.isInTest && this.testUserIds.has(userId)) {
            this.createPeerConnection(userId);
          }
        }, delay);
      }
      this.debounceChangeDetection();
    }
  }

  private handleUserLeft(userId: number) {
    console.log(`[User] User ${userId} left test`);
    this.testUserIds.delete(userId);
    this.closePeerConnection(userId);
    this.users = this.users.filter(u => u.id !== userId);
    this.debounceChangeDetection();
  }

  private async handleTestStarted() {
    console.log('[Test] Test started by admin');
    this.isTestStarted = true;
    if (this.isInTest && !this.isAdmin) {
      await this.startScreenShare();
    }
    this.debounceChangeDetection();
  }

  private handleWindowUpdate(userId: number, windowTitle: string) {
    console.log(`[Window] User ${userId} active window: ${windowTitle}`);
    const existing = this.activeWindows.find(w => w.userId === userId);
    if (existing) {
      existing.windowTitle = windowTitle;
      existing.timestamp = Date.now();
    } else {
      this.activeWindows.push({ userId, windowTitle, timestamp: Date.now() });
    }
    this.sortUsersByActivity();
    this.debounceChangeDetection();
  }

  private createPeerConnection(userId: number): void {
    const user = this.users.find(u => u.id === userId);
    if (!user || userId === parseInt(this.userId)) {
      console.log(`[Peer] Skipping connection to ${userId}: invalid user or self`);
      return;
    }

    if (this.peerConnections.has(userId)) {
      this.closePeerConnection(userId);
    }

    this.activeConnectionCount++;
    const displayName = user?.name || `User ${userId}`;
    const isPolite = parseInt(this.userId) < userId;

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.relay.metered.ca:80" },
        {
          urls: "turn:standard.relay.metered.ca:80",
          username: "0e20581fb4b8fc2be07831e3",
          credential: "1KJmXjnD4HKrE2uk",
        },
        {
          urls: "turn:standard.relay.metered.ca:443",
          username: "0e20581fb4b8fc2be07831e3",
          credential: "1KJmXjnD4HKrE2uk",
        }
      ],
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 5
    });

    const peer: PeerConnection = {
      pc,
      streams: {},
      displayName,
      retryCount: 0,
      lastConnectionAttempt: Date.now(),
      lastOfferSent: 0,
      isPolite,
      wasConnected: false,
      connectionTimeout: null,
      reconnectTimer: null,
      lastCandidate: null,
      pendingMetadata: []
    };
    this.peerConnections.set(userId, peer);
    this.pendingCandidates.set(userId, []);
    this.pendingTracks.set(userId, []);

    peer.connectionTimeout = setTimeout(() => {
      if (pc.connectionState !== 'connected' && pc.connectionState !== 'connecting') {
        console.warn(`[Connection] Timeout for user ${userId}`);
        this.scheduleReconnect(userId);
      }
    }, this.ICE_CONNECTION_TIMEOUT);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log(`[ICE] Sending candidate to user ${userId}`);
        this.socketService.sendMessage(
          JSON.stringify({
            type: 'ice-candidate',
            sender: this.userId,
            receiver: userId,
            candidate: event.candidate
          }),
          false,
          'audioRoom'
        );
      }
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0];
      const track = event.track;
      console.log(`[Track] Received ${track.kind} track from user ${userId}, stream id: ${stream.id}, label: ${track.label}, track id: ${track.id}`);

      if (track.kind === 'audio') {
        this.addAudioElement(userId, stream);
      } else if (track.kind === 'video') {
        // Check if we have metadata for this track
        const trackType = this.trackTypeMap.get(track.id);

        if (trackType) {
          console.log(`[Track] Found metadata for track ${track.id} (${trackType})`);
          const current = this.remoteStreams.get(userId) || {};

          // Create or get the appropriate stream
          let targetStream = current[trackType];
          if (!targetStream) {
            targetStream = new MediaStream();
            current[trackType] = targetStream;
          }

          // Add the track to the stream
          targetStream.addTrack(track);

          // Update the peer connection streams reference
          peer.streams[trackType] = track;

          // Store the updated streams
          this.remoteStreams.set(userId, current);

          // Update the video elements
          this.updateVideoElements(userId);
        } else {
          console.log(`[Track] Buffering track ${track.id} for user ${userId} until metadata arrives`);

          // Create a new stream just for this track temporarily
          const tempStream = new MediaStream([track]);

          // Add to pending tracks
          const pending = this.pendingTracks.get(userId) || [];
          pending.push({ track, stream: tempStream });
          this.pendingTracks.set(userId, pending);

          // If we're the admin, we can create a temporary video element
          if (this.isAdmin) {
            this.createTemporaryVideoElement(userId, track.id, tempStream);
          }
        }
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[Connection] State with user ${userId}: ${pc.connectionState}`);
      peer.lastConnectionAttempt = Date.now();
      switch (pc.connectionState) {
        case 'connected':
          this.activeConnectionCount--;
          peer.retryCount = 0;
          peer.wasConnected = true;
          clearTimeout(peer.connectionTimeout);
          // Send any pending metadata
          if (peer.pendingMetadata.length > 0) {
            peer.pendingMetadata.forEach(metadata => {
              this.socketService.sendMessage(
                JSON.stringify({
                  type: 'track-metadata',
                  sender: this.userId,
                  receiver: userId,
                  trackId: metadata.trackId,
                  streamType: metadata.streamType
                }),
                false,
                'audioRoom'
              );
            });
            peer.pendingMetadata = [];
          }
          break;
        case 'disconnected':
          if (peer.wasConnected) {
            this.scheduleReconnect(userId);
          }
          break;
        case 'failed':
          this.activeConnectionCount--;
          this.scheduleReconnect(userId);
          break;
        case 'closed':
          this.activeConnectionCount--;
          this.closePeerConnection(userId);
          break;
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[ICE] Connection state with user ${userId}: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        this.scheduleReconnect(userId);
      }
    };

    pc.onsignalingstatechange = () => {
      console.log(`[Signaling] State for user ${userId}: ${pc.signalingState}`);
      if (pc.signalingState === 'stable') {
        const pending = this.pendingCandidates.get(userId) || [];
        while (pending.length > 0) {
          const candidate = pending.shift();
          if (candidate) {
            pc.addIceCandidate(candidate).catch(e => console.error('[ICE] Error adding candidate:', e));
          }
        }
        this.pendingCandidates.set(userId, []);
      }
    };

    this.updatePeerTracks(peer);

    if (!peer.isPolite && this.isInTest) {
      setTimeout(() => {
        if (this.peerConnections.has(userId)) {
          this.negotiateConnection(userId);
        }
      }, 50 + Math.random() * 150);
    }
  }

  private createTemporaryVideoElement(userId: number, trackId: string, stream: MediaStream) {
    const userContainer = this.remoteVideoContainers.find(
      container => (container.nativeElement.closest('.user') as HTMLElement | null)?.dataset.userId === userId.toString()
    )?.nativeElement.querySelector('.remote-video');

    if (!userContainer) {
      console.warn(`[TempVideo] No container found for user ${userId}`);
      return;
    }

    // Check if we already have a temporary element for this track
    const existingVideo = userContainer.querySelector(`video.temp-video[data-track-id="${trackId}"]`) as HTMLVideoElement;

    if (!existingVideo) {
      console.log(`[TempVideo] Creating temporary video element for track ${trackId}`);
      const video = document.createElement('video');
      video.classList.add('temp-video');
      video.dataset.userId = userId.toString();
      video.dataset.trackId = trackId;
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true; // Mute temporary videos

      setTimeout(() => {
        video.srcObject = stream;
        this.safePlayVideo(video);
      }, 100);

      userContainer.appendChild(video);
    }
  }

  private scheduleReconnect(userId: number) {
    const peer = this.peerConnections.get(userId);
    if (!peer || !this.isInTest || !this.testUserIds.has(userId)) return;

    if (peer.retryCount >= this.MAX_RETRIES) {
      console.error(`[Reconnect] Max retries reached for user ${userId}`);
      this.closePeerConnection(userId);
      return;
    }

    const delay = this.getRetryDelay(peer.retryCount);
    peer.retryCount++;
    console.log(`[Reconnect] Scheduling reconnect to ${userId} in ${delay}ms (attempt ${peer.retryCount})`);

    clearTimeout(peer.reconnectTimer);
    peer.reconnectTimer = setTimeout(() => {
      if (this.isInTest && this.testUserIds.has(userId)) {
        this.reconnectPeer(userId);
      }
    }, delay);
  }

  private getRetryDelay(attempt: number): number {
    const base = this.BASE_RETRY_DELAY * Math.pow(2, attempt);
    return base * (0.75 + Math.random() * 0.5);
  }

  private reconnectPeer(userId: number) {
    console.log(`[Reconnect] Attempting reconnect to user ${userId}`);
    this.closePeerConnection(userId);
    setTimeout(() => {
      if (this.isInTest && this.testUserIds.has(userId)) {
        this.createPeerConnection(userId);
      }
    }, 500);
  }

  private updatePeerTracks(peer: PeerConnection) {
    const tracks: MediaStreamTrack[] = [];
    const screenTracks = this.screenStream ? this.screenStream.getVideoTracks() : [];
    const cameraTracks = this.cameraStream ? this.cameraStream.getVideoTracks() : [];
    const audioTracks = this.localStream ? this.localStream.getAudioTracks() : [];

    if (audioTracks.length > 0) {
      tracks.push(...audioTracks);
      peer.streams.audio = audioTracks[0];
    }
    if (!this.isAdmin) {
      if (screenTracks.length > 0) {
        tracks.push(...screenTracks);
        peer.streams.screen = screenTracks[0];
      }
      if (cameraTracks.length > 0) {
        tracks.push(...cameraTracks);
        peer.streams.camera = cameraTracks[0];
      }
    }

    tracks.forEach(track => {
      let streamType: StreamTypeMap['type'] = 'audio';
      if (audioTracks.includes(track)) {
        streamType = 'audio';
      } else if (screenTracks.includes(track)) {
        streamType = 'screen';
        track.contentHint = 'detail';
      } else if (cameraTracks.includes(track)) {
        streamType = 'camera';
        track.contentHint = 'motion';
      }
      const stream = new MediaStream([track]);
      if (!peer.pc.getSenders().some(s => s.track === track)) {
        console.log(`[Track] Adding ${streamType} track to peer ${peer.displayName}, track id: ${track.id}`);
        peer.pc.addTrack(track, stream);
        this.streamTypeMap.set(stream, { stream, type: streamType });
        // Buffer track metadata until connection is stable
        if (streamType === 'screen' || streamType === 'camera') {
          peer.pendingMetadata.push({ trackId: track.id, streamType });
        }
      }
    });
  }

  private addAudioElement(userId: number, stream: MediaStream) {
    const existingAudio = this.audioContainerRef.nativeElement.querySelector(`audio[data-user-id="${userId}"]`);
    if (!existingAudio) {
      const audio = document.createElement('audio');
      audio.srcObject = stream;
      audio.autoplay = true;
      audio.dataset.userId = userId.toString();
      this.audioContainerRef.nativeElement.appendChild(audio);
    }
  }

  private updateVideoElements(userId: number) {
    const userContainer = this.remoteVideoContainers.find(
      container => (container.nativeElement.closest('.user') as HTMLElement | null)?.dataset.userId === userId.toString()
    )?.nativeElement.querySelector('.remote-video');

    if (!userContainer) {
      console.warn(`[Video] No container found for user ${userId}`);
      return;
    }

    const streams = this.remoteStreams.get(userId) || {};

    // Handle screen stream
    if (streams.screen) {
      const existingScreen = userContainer.querySelector(`video.screen-share[data-user-id="${userId}"]`) as HTMLVideoElement;

      if (!existingScreen) {
        console.log(`[Video] Adding screen stream for user ${userId}`);
        const screenVideo = document.createElement('video');
        screenVideo.classList.add('screen-share');
        screenVideo.dataset.userId = userId.toString();
        screenVideo.dataset.streamType = 'screen';
        screenVideo.autoplay = true;
        screenVideo.playsInline = true;

        setTimeout(() => {
          screenVideo.srcObject = streams.screen ?? null;
          this.safePlayVideo(screenVideo);
        }, 100);

        userContainer.appendChild(screenVideo);

        // Remove any temporary video for these tracks
        streams.screen.getTracks().forEach(track => {
          const tempVideo = userContainer.querySelector(`video.temp-video[data-track-id="${track.id}"]`);
          if (tempVideo) tempVideo.remove();
        });
      }
    }

    // Handle camera stream
    if (streams.camera) {
      const existingCamera = userContainer.querySelector(`video.camera-video[data-user-id="${userId}"]`) as HTMLVideoElement;

      if (!existingCamera) {
        console.log(`[Video] Adding camera stream for user ${userId}`);
        const cameraVideo = document.createElement('video');
        cameraVideo.classList.add('camera-video');
        cameraVideo.dataset.userId = userId.toString();
        cameraVideo.dataset.streamType = 'camera';
        cameraVideo.autoplay = true;
        cameraVideo.playsInline = true;

        setTimeout(() => {
          cameraVideo.srcObject = streams.camera ?? null;
          this.safePlayVideo(cameraVideo);
        }, 100);

        // Position after screen share if it exists
        const referenceNode = userContainer.querySelector('video.screen-share')?.nextSibling || null;
        userContainer.insertBefore(cameraVideo, referenceNode);

        // Remove any temporary video for these tracks
        streams.camera.getTracks().forEach(track => {
          const tempVideo = userContainer.querySelector(`video.temp-video[data-track-id="${track.id}"]`);
          if (tempVideo) tempVideo.remove();
        });
      }
    }

    this.debounceChangeDetection();
  }

  joinaudioRoom() {
    this.joinTestRoom();
  }

  startTest() {
    if (!this.isAdmin || this.isTestStarted) return;
    console.log('[Test] Admin starting test');
    this.isTestStarted = true;
    this.socketService.sendMessage('test_started', false, 'audioRoom');
    this.debounceChangeDetection();
  }

  async startScreenShare() {
    if (this.isScreenSharing || this.isAdmin) return;
    console.log('[ScreenShare] Starting screen and camera share');
    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 30 } },
        audio: false
      });
      this.streamTypeMap.set(this.screenStream, { stream: this.screenStream, type: 'screen' });

      this.cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { max: 320 }, height: { max: 240 }, frameRate: { max: 30 } }
      });
      this.streamTypeMap.set(this.cameraStream, { stream: this.cameraStream, type: 'camera' });

      this.isScreenSharing = true;
      this.isCameraEnabled = true;
      this.screenStream.getTracks().forEach(track => {
        track.contentHint = 'detail';
        track.addEventListener('ended', () => {
          this.stopScreenShare();
        });
      });
      this.cameraStream.getTracks().forEach(track => {
        track.contentHint = 'motion';
      });

      if (this.localStream) {
        const newStream = new MediaStream([
          ...this.localStream.getAudioTracks(),
          ...this.screenStream.getVideoTracks(),
          ...this.cameraStream.getVideoTracks()
        ]);
        this.localStream.getVideoTracks().forEach(track => track.stop());
        this.localStream = newStream;
        this.streamTypeMap.set(newStream, { stream: newStream, type: 'combined' });
      } else {
        this.localStream = new MediaStream([
          ...this.screenStream.getVideoTracks(),
          ...this.cameraStream.getVideoTracks()
        ]);
        this.streamTypeMap.set(this.localStream, { stream: this.localStream, type: 'combined' });
      }

      if (this.localVideoRef?.nativeElement) {
        this.localVideoRef.nativeElement.srcObject = this.localStream;
        this.safePlayVideo(this.localVideoRef.nativeElement);
      }

      this.peerConnections.forEach((peer, userId) => {
        const user = this.users.find(u => u.id === userId);
        if (user?.isAdmin) {
          this.updatePeerTracks(peer);
          if (peer.pc.signalingState === 'stable' && !this.negotiationLock.get(userId)) {
            this.negotiateConnection(userId);
          }
        }
      });
    } catch (err) {
      console.error('[ScreenShare] Failed to share screen or camera:', err);
      this.isScreenSharing = false;
      this.isCameraEnabled = false;
      this.screenStream?.getTracks().forEach(track => track.stop());
      this.cameraStream?.getTracks().forEach(track => track.stop());
      this.streamTypeMap.delete(this.screenStream!);
      this.streamTypeMap.delete(this.cameraStream!);
      this.screenStream = undefined;
      this.cameraStream = undefined;
      alert('Screen or camera sharing failed.');
    }
    this.debounceChangeDetection();
  }

  stopScreenShare() {
    if (!this.isScreenSharing) return;
    console.log('[ScreenShare] Stopping screen and camera share');
    this.screenStream?.getTracks().forEach(track => track.stop());
    this.cameraStream?.getTracks().forEach(track => track.stop());
    this.streamTypeMap.delete(this.screenStream!);
    this.streamTypeMap.delete(this.cameraStream!);
    this.screenStream = undefined;
    this.cameraStream = undefined;
    this.isScreenSharing = false;
    this.isCameraEnabled = false;

    if (this.localStream) {
      const newStream = new MediaStream([...this.localStream.getAudioTracks()]);
      this.localStream.getVideoTracks().forEach(track => track.stop());
      this.streamTypeMap.delete(this.localStream);
      this.localStream = newStream;
      this.streamTypeMap.set(newStream, { stream: newStream, type: 'audio' });
      if (this.localVideoRef?.nativeElement) {
        this.localVideoRef.nativeElement.srcObject = this.localStream;
        this.safePlayVideo(this.localVideoRef.nativeElement);
      }
    } else {
      if (this.localVideoRef?.nativeElement) {
        this.localVideoRef.nativeElement.srcObject = null;
      }
    }

    this.peerConnections.forEach((peer, userId) => {
      const user = this.users.find(u => u.id === userId);
      if (user?.isAdmin) {
        this.updatePeerTracks(peer);
        if (peer.pc.signalingState === 'stable' && !this.negotiationLock.get(userId)) {
          this.negotiateConnection(userId);
        }
      }
    });
    this.debounceChangeDetection();
  }

  private async negotiateConnection(userId: number) {
    const peer = this.peerConnections.get(userId);
    if (!peer || peer.pc.signalingState !== 'stable' || this.negotiationLock.get(userId)) {
      return;
    }

    const now = Date.now();
    if (peer.lastOfferSent > 0 && now - peer.lastOfferSent < this.OFFER_COOLDOWN) {
      setTimeout(() => this.negotiateConnection(userId), this.OFFER_COOLDOWN - (now - peer.lastOfferSent));
      return;
    }

    this.negotiationLock.set(userId, true);
    try {
      console.log(`[Negotiation] Creating offer for ${userId}`);
      const offer = await peer.pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: this.isAdmin,
        iceRestart: peer.retryCount > 0
      });
      await peer.pc.setLocalDescription(offer);
      peer.lastOfferSent = now;

      this.socketService.sendMessage(
        JSON.stringify({
          type: 'offer',
          sender: this.userId,
          receiver: userId,
          sdp: offer.sdp,
          isInitial: peer.retryCount === 0
        }),
        false,
        'audioRoom'
      );
    } catch (error) {
      console.error('[Negotiation] Error:', error);
      this.scheduleReconnect(userId);
    } finally {
      this.negotiationLock.set(userId, false);
    }
  }

  private validateConnectionState(userId: number, operation: string): boolean {
    const peer = this.peerConnections.get(userId);
    if (!peer) {
      console.warn(`[Validation] No peer connection for ${userId} during ${operation}`);
      return false;
    }

    // Add any specific state validations here
    if (operation === 'setRemoteDescription' &&
        peer.pc.signalingState !== 'have-local-offer') {
      console.warn(`[Validation] Cannot ${operation} in state ${peer.pc.signalingState}`);
      return false;
    }

    return true;
  }

  private async handleSignalingData(data: any) {
    // Proper validation of sender/receiver
    const senderId = parseInt(data.sender);
    const receiverId = parseInt(data.receiver);
    const currentUserId = parseInt(this.userId);

    if (isNaN(senderId)) {
      console.warn('[Signaling] Invalid sender ID:', data.sender);
      return;
    }

    if (isNaN(receiverId) || receiverId !== currentUserId) {
      console.warn(`[Signaling] Message not for this user (expected ${currentUserId}, got ${receiverId})`);
      return;
    }

    if (senderId === currentUserId) {
      console.warn('[Signaling] Ignoring message from self');
      return;
    }

    if (!this.testUserIds.has(senderId)) {
      console.warn(`[Signaling] Ignoring message from unknown user ${senderId}`);
      return;
    }

    switch (data.type) {
      case 'offer':
        await this.handleOffer(senderId, data);
        break;
      case 'answer':
        await this.handleAnswer(senderId, data);
        break;
      case 'ice-candidate':
        await this.handleCandidate(senderId, data.candidate);
        break;
      case 'track-metadata':
        this.handleTrackMetadata(senderId, data);
        break;
    }
  }

  private async handleOffer(userId: number, data: any) {
    let peer = this.peerConnections.get(userId);
    if (!peer) {
      this.createPeerConnection(userId);
      peer = this.peerConnections.get(userId);
    }
    if (!peer || this.negotiationLock.get(userId)) {
      return;
    }

    this.negotiationLock.set(userId, true);
    try {
      const sdp = new RTCSessionDescription(data);
      if (peer.pc.signalingState !== 'stable') {
        if (peer.isPolite) {
          return;
        } else {
          await peer.pc.setLocalDescription({ type: 'rollback' });
        }
      }

      await peer.pc.setRemoteDescription(sdp);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      this.socketService.sendMessage(
        JSON.stringify({
          type: 'answer',
          sender: this.userId,
          receiver: userId,
          sdp: answer.sdp
        }),
        false,
        'audioRoom'
      );
    } catch (error) {
      console.error(`[Offer ${userId}] Error handling offer:`, error);
      this.scheduleReconnect(userId);
    } finally {
      this.negotiationLock.set(userId, false);
    }
  }

  private async handleAnswer(userId: number, data: any) {
    const peer = this.peerConnections.get(userId);
    if (!peer) {
      console.warn(`[Answer ${userId}] No peer connection exists`);
      return;
    }

    try {
      const description = new RTCSessionDescription(data);

      // Check if we're in a state where we can accept an answer
      if (peer.pc.signalingState !== 'have-local-offer') {
        console.warn(`[Answer ${userId}] Cannot accept answer in current signaling state: ${peer.pc.signalingState}`);
        return;
      }

      console.log(`[Answer ${userId}] Setting remote description`);
      await peer.pc.setRemoteDescription(description);

    } catch (error) {
      console.error(`[Answer ${userId}] Error handling answer:`, error);

      // Attempt to recover from invalid state
      if (typeof error === 'object' && error !== null && 'toString' in error && typeof (error as any).toString === 'function' && (error as any).toString().includes('Called in wrong state')) {
        console.log(`[Answer ${userId}] Attempting to recover from invalid state`);
        this.scheduleReconnect(userId);
      }
    }
  }

  private async handleCandidate(userId: number, candidate: any) {
    const peer = this.peerConnections.get(userId);
    if (!peer) return;

    const candidateString = JSON.stringify(candidate);
    if (peer.lastCandidate === candidateString) return;
    peer.lastCandidate = candidateString;

    const rtcCandidate = new RTCIceCandidate(candidate);
    try {
      if (peer.pc.remoteDescription) {
        await peer.pc.addIceCandidate(rtcCandidate);
      } else {
        const pending = this.pendingCandidates.get(userId) || [];
        pending.push(rtcCandidate);
        this.pendingCandidates.set(userId, pending);
      }
    } catch (error) {
      console.error(`[ICE ${userId}] Error adding candidate:`, error);
    }
  }

  private handleTrackMetadata(userId: number, data: any) {
    if (data.trackId && data.streamType) {
      console.log(`[TrackMetadata] Received metadata for user ${userId}: track ${data.trackId} is ${data.streamType}`);

      // Store the track type mapping
      this.trackTypeMap.set(data.trackId, data.streamType);

      // Process any pending tracks for this user
      const pending = this.pendingTracks.get(userId) || [];
      const remaining: { track: MediaStreamTrack; stream: MediaStream }[] = [];

      pending.forEach(({ track, stream }) => {
        if (track.id === data.trackId) {
          console.log(`[TrackMetadata] Processing pending track ${track.id} for user ${userId}`);

          const peer = this.peerConnections.get(userId);
          if (peer) {
            // Get or create the stream container for this user
            const current = this.remoteStreams.get(userId) || {};

            // Create a new stream if needed or reuse existing one
            let targetStream = current[data.streamType as 'screen' | 'camera'];
            if (!targetStream) {
              targetStream = new MediaStream();
              current[data.streamType as 'screen' | 'camera'] = targetStream;
            }

            // Add the track to the appropriate stream
            targetStream.addTrack(track);

            // Update the peer connection streams reference
            peer.streams[data.streamType as 'screen' | 'camera'] = track;

            // Store the updated streams
            this.remoteStreams.set(userId, current);

            // Update the video elements
            this.updateVideoElements(userId);
          }
        } else {
          remaining.push({ track, stream });
        }
      });

      this.pendingTracks.set(userId, remaining);

      // Also check if we have any existing streams that need this metadata
      const peer = this.peerConnections.get(userId);
      if (peer) {
        const currentStreams = this.remoteStreams.get(userId) || {};
        if (data.streamType === 'screen' && currentStreams.screen) {
          currentStreams.screen.getTracks().forEach(track => {
            if (track.id === data.trackId) {
              this.trackTypeMap.set(track.id, 'screen');
            }
          });
        }
        if (data.streamType === 'camera' && currentStreams.camera) {
          currentStreams.camera.getTracks().forEach(track => {
            if (track.id === data.trackId) {
              this.trackTypeMap.set(track.id, 'camera');
            }
          });
        }
      }
    }
  }

  private closePeerConnection(userId: number) {
    const peer = this.peerConnections.get(userId);
    if (peer) {
      if (peer.pc.connectionState !== 'closed') {
        peer.pc.close();
      }
      clearTimeout(peer.connectionTimeout);
      clearTimeout(peer.reconnectTimer);

      const streams = this.remoteStreams.get(userId);
      if (streams) {
        if (streams.camera) {
          streams.camera.getTracks().forEach(track => {
            track.stop();
            this.trackTypeMap.delete(track.id);
          });
          this.streamTypeMap.delete(streams.camera);
        }
        if (streams.screen) {
          streams.screen.getTracks().forEach(track => {
            track.stop();
            this.trackTypeMap.delete(track.id);
          });
          this.streamTypeMap.delete(streams.screen);
        }
        this.remoteStreams.delete(userId);
      }

      const audioElements = this.audioContainerRef.nativeElement.querySelectorAll(`audio[data-user-id="${userId}"]`);
      audioElements.forEach((audio: Element) => {
        (audio as HTMLAudioElement).srcObject = null;
        audio.remove();
      });

      const userContainer = this.remoteVideoContainers.find(
        container => (container.nativeElement.closest('.user') as HTMLElement | null)?.dataset.userId === userId.toString()
      )?.nativeElement.querySelector('.remote-video');

      if (userContainer) {
        const userVideos = userContainer.querySelectorAll(`video[data-user-id="${userId}"]`);
        userVideos.forEach(video => {
          (video as HTMLVideoElement).srcObject = null;
          video.remove();
        });
      }

      this.peerConnections.delete(userId);
      this.pendingCandidates.delete(userId);
      this.pendingTracks.delete(userId);
      this.negotiationLock.delete(userId);
      this.activeConnectionCount = Math.max(0, this.activeConnectionCount - 1);
    }
  }

  leaveTest() {
    console.log('[Test] Leaving test');
    this.peerConnections.forEach((_, userId) => this.closePeerConnection(userId));
    this.localStream?.getTracks().forEach(track => track.stop());
    this.screenStream?.getTracks().forEach(track => track.stop());
    this.cameraStream?.getTracks().forEach(track => track.stop());
    if (this.localStream) this.streamTypeMap.delete(this.localStream);
    if (this.screenStream) this.streamTypeMap.delete(this.screenStream);
    if (this.cameraStream) this.streamTypeMap.delete(this.cameraStream);
    this.localStream = undefined;
    this.screenStream = undefined;
    this.cameraStream = undefined;
    this.isInTest = false;
    this.isTestStarted = false;
    this.isScreenSharing = false;
    this.isCameraEnabled = false;
    this.isMicMuted = false;
    if (this.localVideoRef?.nativeElement) {
      this.localVideoRef.nativeElement.srcObject = null;
    }
    this.audioContainerRef.nativeElement.innerHTML = '';
    this.remoteStreams.clear();
    this.streamTypeMap.clear();
    this.trackTypeMap.clear();
    this.pendingTracks.clear();
    this.socketService.sendMessage(`user_left_call:&${this.userId}`, false, 'audioRoom');
    this.debounceChangeDetection();
  }

  toggleMic() {
    this.isMicMuted = !this.isMicMuted;
    this.localStream?.getTracks().forEach(track => {
      if (track.kind === 'audio') {
        track.enabled = !this.isMicMuted;
      }
    });
    this.debounceChangeDetection();
  }

  private startWindowTracking() {
    this.windowCheckInterval = setInterval(async () => {
      if (!this.isInTest || !this.electronService.isElectron()) return;
      const activeWindow = await this.electronService.getActiveWindow();
      if (activeWindow) {
        this.socketService.sendMessage(
          `window_update:&${this.userId}:&${activeWindow.title}`,
          false,
          'audioRoom'
        );
      }
    }, 5000);
  }

  private sortUsersByActivity() {
    this.users.sort((a, b) => {
      const aWindow = this.activeWindows.find(w => w.userId === a.id);
      const bWindow = this.activeWindows.find(w => w.userId === b.id);
      if (!aWindow) return 1;
      if (!bWindow) return -1;
      return bWindow.timestamp - aWindow.timestamp;
    });
  }

  getActiveWindowTitle(userId: number): string | null {
    const window = this.activeWindows.find(w => w.userId === userId);
    return window ? window.windowTitle : null;
  }

  private safePlayVideo(element: HTMLVideoElement) {
    if (element.srcObject) {
      element.play().catch(err => {
        console.error('[Video] Play error:', err);
        if (err.name === 'NotAllowedError') {
          document.addEventListener('click', () => element.play().catch(e => console.error('[Video] Retry play error:', e)), { once: true });
        }
      });
    }
  }

  private debounceChangeDetection() {
    if (this.changeDetectionTimeout) clearTimeout(this.changeDetectionTimeout);
    this.changeDetectionTimeout = setTimeout(() => {
      console.log('[CD] Triggering change detection');
      this.cdr.detectChanges();
    }, 100);
  }
}
