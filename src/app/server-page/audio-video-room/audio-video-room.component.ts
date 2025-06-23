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
import api from '../../services/api.service';

interface PeerConnection {
  pc: RTCPeerConnection;
  streams: {
    audio?: MediaStreamTrack;
    camera?: MediaStreamTrack;
    screen?: MediaStreamTrack;
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

interface StreamTypeMap {
  stream: MediaStream;
  type: 'audio' | 'screen' | 'camera' | 'combined';
}

@Component({
  selector: 'app-audio-video-room',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './audio-video-room.component.html',
  styleUrls: ['./audio-video-room.component.scss']
})
export class AudioVideoRoomComponent implements OnInit, OnDestroy {
  @ViewChild('localVideo', { static: false }) localVideoRef!: ElementRef<HTMLVideoElement>;
  @ViewChild('audioContainer', { static: false }) audioContainerRef!: ElementRef<HTMLDivElement>;
  @ViewChildren('remoteVideoContainer') remoteVideoContainers!: QueryList<ElementRef<HTMLDivElement>>;

  roomId: number = 14;
  userId: string = this.authService.getUser().id;

  users: any[] = [];
  voiceUserIds: Set<number> = new Set();

  localStream?: MediaStream;
  screenStream?: MediaStream;
  cameraStream?: MediaStream;

  peerConnections = new Map<number, PeerConnection>();
  remoteStreams = new Map<number, { camera?: MediaStream; screen?: MediaStream }>();
  pendingCandidates = new Map<number, RTCIceCandidate[]>();
  private streamTypeMap = new Map<MediaStream, StreamTypeMap>();
  private trackTypeMap = new Map<string, 'screen' | 'camera'>();
  private pendingTracks = new Map<number, { track: MediaStreamTrack; stream: MediaStream }[]>();

  isInCall = false;
  isScreenSharing = false;
  isCameraEnabled = false;
  isMicMuted = false;

  private changeDetectionTimeout: any;
  private negotiationLock = new Map<number, boolean>();
  private readonly MAX_RETRIES = 2;
  private readonly BASE_RETRY_DELAY = 1000;
  private readonly ICE_CONNECTION_TIMEOUT = 3000;
  private readonly OFFER_COOLDOWN = 1500;
  private readonly INITIAL_CONNECTION_DELAY = 300;
  private readonly MAX_PARALLEL_CONNECTIONS = 3;

  private activeConnectionCount = 0;

  constructor(
    private userService: UsersService,
    private authService: AuthService,
    private socketService: SocketService,
    private cdr: ChangeDetectorRef
  ) {}

  async ngOnInit() {
    console.log('[Init] Initializing audio-video room component');
    await this.fetchInitialUsers();
    this.setupSocketListeners();
    this.socketService.joinAudioRoom(this.roomId.toString());
  }

  ngOnDestroy() {
    console.log('[Destroy] Cleaning up audio-video room component');
    this.leaveCall();
    if (this.changeDetectionTimeout) {
      clearTimeout(this.changeDetectionTimeout);
    }
  }

  private async fetchInitialUsers() {
    try {
      const res = await api.get(`http://lamzaone.go.ro:8000/api/room/${this.roomId}/users`);
      this.users = await Promise.all(
        res.data.userIds.map(async (id: string) => {
          const user = await this.userService.getUserInfo(id);
          return { ...user, id: parseInt(id) };
        })
      );
      console.log('[Init] Users fetched:', this.users);
      this.voiceUserIds = new Set(this.users.map(u => u.id));
      this.debounceChangeDetection();
    } catch (error) {
      console.error('[Init] Failed to fetch users', error);
    }
  }

  private setupSocketListeners() {
    console.log('[Socket] Setting up socket listeners');
    this.socketService.onAudioRoomMessage((message: string) => {
      if (message.startsWith('user_joined_call')) {
        const parts = message.split(':&');
        if (parts.length === 2) {
          const userId = parseInt(parts[1]);
          if (!isNaN(userId)) {
            this.handleUserJoined(userId);
          }
        }
      } else if (message.startsWith('user_left_call')) {
        const parts = message.split(':&');
        if (parts.length === 2) {
          const userId = parseInt(parts[1]);
          if (!isNaN(userId)) {
            this.handleUserLeft(userId);
          }
        }
      } else {
        try {
          const data = JSON.parse(message);
          if (data.type === 'ice-candidate' || data.type === 'offer' || data.type === 'answer' || data.type === 'track-metadata') {
            this.handleSignalingData(data);
          }
        } catch (error) {
          console.error('[Socket] Error parsing message:', error);
        }
      }
      this.debounceChangeDetection();
    });
  }

  private async handleUserJoined(userId: number) {
    if (!this.voiceUserIds.has(userId) && userId !== parseInt(this.userId)) {
      console.log(`[User] User ${userId} joined`);
      this.voiceUserIds.add(userId);

      if (!this.users.find(u => u.id === userId)) {
        this.users.push({ id: userId, name: `User ${userId}`, picture: '' });
        this.userService.getUserInfo(userId.toString()).then(user => {
          const existingUser = this.users.find(u => u.id === userId);
          if (existingUser) {
            Object.assign(existingUser, user);
            this.debounceChangeDetection();
          }
        }).catch(() => { /* ignore errors */ });
      }

      if (this.isInCall) {
        const delay = this.activeConnectionCount < this.MAX_PARALLEL_CONNECTIONS
          ? this.INITIAL_CONNECTION_DELAY
          : this.INITIAL_CONNECTION_DELAY;

        console.log(`[User] Scheduling connection for user ${userId} in ${delay}ms`);
        setTimeout(() => {
          if (this.isInCall && this.voiceUserIds.has(userId)) {
            this.createPeerConnection(userId);
          }
        }, delay);
      }
      this.debounceChangeDetection();
    }
  }

  private handleUserLeft(userId: number) {
    console.log(`[User] User ${userId} left`);
    this.voiceUserIds.delete(userId);
    this.closePeerConnection(userId);
    this.users = this.users.filter(u => u.id !== userId);
    this.debounceChangeDetection();
  }

  private createPeerConnection(userId: number): void {
    if (this.peerConnections.has(userId)) {
      this.closePeerConnection(userId);
    }

    this.activeConnectionCount++;
    const user = this.users.find(u => u.id === userId);
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
          urls: "turn:standard.relay.metered.ca:80?transport=tcp",
          username: "0e20581fb4b8fc2be07831e3",
          credential: "1KJmXjnD4HKrE2uk",
        },
        {
          urls: "turn:standard.relay.metered.ca:443",
          username: "0e20581fb4b8fc2be07831e3",
          credential: "1KJmXjnD4HKrE2uk",
        },
        {
          urls: "turns:standard.relay.metered.ca:443?transport=tcp",
          username: "0e20581fb4b8fc2be07831e3",
          credential: "1KJmXjnD4HKrE2uk",
        },
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
        console.log(`[ICE] Sending ICE candidate to user ${userId}`);
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

      console.log(`[Track] Received ${track.kind} track from user ${userId}, stream id: ${stream.id}, track id: ${track.id}`);

      if (track.kind === 'audio' && userId !== parseInt(this.userId)) {
        this.addAudioElement(userId, stream);
      } else if (track.kind === 'video') {
        const trackType = this.trackTypeMap.get(track.id);
        if (trackType) {
          console.log(`[Track] Found metadata for track ${track.id} (${trackType})`);
          const current = this.remoteStreams.get(userId) || {};
          let targetStream = current[trackType];
          if (!targetStream) {
            targetStream = new MediaStream();
            current[trackType] = targetStream;
          }
          targetStream.addTrack(track);
          peer.streams[trackType] = track;
          this.remoteStreams.set(userId, current);
          this.updateVideoElements(userId);
        } else {
          console.log(`[Track] Buffering track ${track.id} for user ${userId} until metadata arrives`);
          const tempStream = new MediaStream([track]);
          const pending = this.pendingTracks.get(userId) || [];
          pending.push({ track, stream: tempStream });
          this.pendingTracks.set(userId, pending);
          this.createTemporaryVideoElement(userId, track.id, tempStream);
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

    if (!peer.isPolite && this.isInCall) {
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

    const existingVideo = userContainer.querySelector(`video.temp-video[data-track-id="${trackId}"]`) as HTMLVideoElement;
    if (!existingVideo) {
      console.log(`[TempVideo] Creating temporary video element for track ${trackId}`);
      const video = document.createElement('video');
      video.classList.add('temp-video');
      video.dataset.userId = userId.toString();
      video.dataset.trackId = trackId;
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true;

      setTimeout(() => {
        video.srcObject = stream;
        this.safePlayVideo(video);
      }, 100);

      userContainer.appendChild(video);
    }
  }

  private scheduleReconnect(userId: number) {
    const peer = this.peerConnections.get(userId);
    if (!peer || !this.isInCall || !this.voiceUserIds.has(userId)) return;

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
      if (this.isInCall && this.voiceUserIds.has(userId)) {
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
      if (this.isInCall && this.voiceUserIds.has(userId)) {
        this.createPeerConnection(userId);
      }
    }, 500);
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

  private updatePeerTracks(peer: PeerConnection) {
    const tracks: MediaStreamTrack[] = [];
    const screenTracks = this.screenStream ? this.screenStream.getVideoTracks() : [];
    const cameraTracks = this.cameraStream ? this.cameraStream.getVideoTracks() : [];
    const audioTracks = this.localStream ? this.localStream.getAudioTracks() : [];

    if (audioTracks.length > 0) {
      tracks.push(...audioTracks);
      peer.streams.audio = audioTracks[0];
    }
    if (screenTracks.length > 0) {
      tracks.push(...screenTracks);
      peer.streams.screen = screenTracks[0];
    }
    if (cameraTracks.length > 0) {
      tracks.push(...cameraTracks);
      peer.streams.camera = cameraTracks[0];
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
        if (streamType === 'screen' || streamType === 'camera') {
          peer.pendingMetadata.push({ trackId: track.id, streamType });
        }
      }
    });
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

        streams.screen.getTracks().forEach(track => {
          const tempVideo = userContainer.querySelector(`video.temp-video[data-track-id="${track.id}"]`);
          if (tempVideo) tempVideo.remove();
        });
      }
    }

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

        const referenceNode = userContainer.querySelector('video.screen-share')?.nextSibling || null;
        userContainer.insertBefore(cameraVideo, referenceNode);

        streams.camera.getTracks().forEach(track => {
          const tempVideo = userContainer.querySelector(`video.temp-video[data-track-id="${track.id}"]`);
          if (tempVideo) tempVideo.remove();
        });
      }
    }

    this.debounceChangeDetection();
  }

  async joinVoiceRoom() {
    if (this.isInCall) return;

    console.log('[Call] Joining voice room');
    try {
      const mediaPromise = navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: this.isCameraEnabled ? { width: { max: 320 }, height: { max: 240 }, frameRate: { max: 30 } } : false
      });

      this.isInCall = true;
      this.socketService.sendMessage(`user_joined_call:&${this.userId}`, false, 'audioRoom');
      this.voiceUserIds.add(parseInt(this.userId));

      this.users.forEach((user, index) => {
        if (user.id !== parseInt(this.userId) && this.voiceUserIds.has(user.id)) {
          setTimeout(() => {
            if (this.isInCall && this.voiceUserIds.has(user.id)) {
              this.createPeerConnection(user.id);
            }
          }, 100);
        }
      });

      this.localStream = await mediaPromise;
      this.streamTypeMap.set(this.localStream, { stream: this.localStream, type: this.isCameraEnabled ? 'combined' : 'audio' });

      if (this.localVideoRef?.nativeElement) {
        this.localVideoRef.nativeElement.srcObject = this.localStream;
        this.localVideoRef.nativeElement.muted = true;
        this.safePlayVideo(this.localVideoRef.nativeElement);
      }

      this.debounceChangeDetection();
    } catch (error) {
      console.error('[Call] Error joining call:', error);
      this.isInCall = false;
    }
  }

  async toggleScreenShare() {
    if (this.isScreenSharing) {
      this.stopScreenShare();
    } else {
      try {
        this.screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 30 } },
          audio: false
        });
        this.streamTypeMap.set(this.screenStream, { stream: this.screenStream, type: 'screen' });

        this.screenStream.getTracks().forEach(track => {
          track.contentHint = 'detail';
          track.addEventListener('ended', () => {
            this.stopScreenShare();
          });
        });

        this.isScreenSharing = true;

        if (this.localStream) {
          const newStream = new MediaStream([
            ...this.localStream.getAudioTracks(),
            ...this.screenStream.getVideoTracks(),
            ...(this.cameraStream ? this.cameraStream.getVideoTracks() : [])
          ]);
          this.localStream.getVideoTracks().forEach(track => track.stop());
          this.localStream = newStream;
          this.streamTypeMap.set(newStream, { stream: newStream, type: 'combined' });
        } else {
          this.localStream = new MediaStream([...this.screenStream.getVideoTracks()]);
          this.streamTypeMap.set(this.localStream, { stream: this.localStream, type: 'screen' });
        }

        if (this.localVideoRef?.nativeElement) {
          this.localVideoRef.nativeElement.srcObject = this.localStream;
          this.safePlayVideo(this.localVideoRef.nativeElement);
        }

        this.peerConnections.forEach((peer, userId) => {
          this.updatePeerTracks(peer);
          if (peer.pc.signalingState === 'stable' && !this.negotiationLock.get(userId)) {
            this.negotiateConnection(userId);
          }
        });
      } catch (err) {
        console.error('[ScreenShare] Failed to share screen:', err);
        this.isScreenSharing = false;
        this.screenStream = undefined;
        this.streamTypeMap.delete(this.screenStream!);
      }
    }
    this.debounceChangeDetection();
  }

  private stopScreenShare() {
    this.screenStream?.getTracks().forEach(track => track.stop());
    this.streamTypeMap.delete(this.screenStream!);
    this.screenStream = undefined;
    this.isScreenSharing = false;

    if (this.isCameraEnabled && this.cameraStream) {
      this.localStream = new MediaStream([
        ...(this.localStream?.getAudioTracks() || []),
        ...this.cameraStream.getVideoTracks()
      ]);
      this.streamTypeMap.set(this.localStream, { stream: this.localStream, type: 'combined' });
    } else {
      this.localStream = this.localStream ? new MediaStream([...this.localStream.getAudioTracks()]) : undefined;
      this.streamTypeMap.set(this.localStream!, { stream: this.localStream!, type: 'audio' });
    }

    if (this.localVideoRef?.nativeElement) {
      this.localVideoRef.nativeElement.srcObject = this.localStream || null;
    }

    this.peerConnections.forEach((peer, userId) => {
      this.updatePeerTracks(peer);
      if (peer.pc.signalingState === 'stable' && !this.negotiationLock.get(userId)) {
        this.negotiateConnection(userId);
      }
    });
  }

  async toggleCamera() {
    if (this.isCameraEnabled) {
      this.stopCamera();
    } else {
      try {
        this.cameraStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { max: 320 }, height: { max: 240 }, frameRate: { max: 30 } }
        });
        this.streamTypeMap.set(this.cameraStream, { stream: this.cameraStream, type: 'camera' });

        this.cameraStream.getTracks().forEach(track => {
          track.contentHint = 'motion';
        });

        this.isCameraEnabled = true;

        if (this.localStream) {
          this.localStream.getVideoTracks().forEach(track => track.stop());
          const newStream = new MediaStream([
            ...this.localStream.getAudioTracks(),
            ...this.cameraStream.getVideoTracks(),
            ...(this.screenStream ? this.screenStream.getVideoTracks() : [])
          ]);
          this.localStream = newStream;
          this.streamTypeMap.set(newStream, { stream: newStream, type: 'combined' });
        } else {
          this.localStream = new MediaStream([...this.cameraStream.getVideoTracks()]);
          this.streamTypeMap.set(this.localStream, { stream: this.localStream, type: 'camera' });
        }

        if (this.localVideoRef?.nativeElement) {
          this.localVideoRef.nativeElement.srcObject = this.localStream;
          this.safePlayVideo(this.localVideoRef.nativeElement);
        }

        this.peerConnections.forEach((peer, userId) => {
          this.updatePeerTracks(peer);
          if (peer.pc.signalingState === 'stable' && !this.negotiationLock.get(userId)) {
            this.negotiateConnection(userId);
          }
        });
      } catch (error) {
        console.error('[Camera] Failed to enable camera:', error);
        this.isCameraEnabled = false;
        this.cameraStream = undefined;
        this.streamTypeMap.delete(this.cameraStream!);
      }
    }
    this.debounceChangeDetection();
  }

  private stopCamera() {
    this.cameraStream?.getTracks().forEach(track => track.stop());
    this.streamTypeMap.delete(this.cameraStream!);
    this.cameraStream = undefined;
    this.isCameraEnabled = false;

    if (this.isScreenSharing && this.screenStream) {
      this.localStream = new MediaStream([
        ...(this.localStream?.getAudioTracks() || []),
        ...this.screenStream.getVideoTracks()
      ]);
      this.streamTypeMap.set(this.localStream, { stream: this.localStream, type: 'combined' });
    } else {
      this.localStream = this.localStream ? new MediaStream([...this.localStream.getAudioTracks()]) : undefined;
      this.streamTypeMap.set(this.localStream!, { stream: this.localStream!, type: 'audio' });
    }

    if (this.localVideoRef?.nativeElement) {
      this.localVideoRef.nativeElement.srcObject = this.localStream || null;
    }

    this.peerConnections.forEach((peer, userId) => {
      this.updatePeerTracks(peer);
      if (peer.pc.signalingState === 'stable' && !this.negotiationLock.get(userId)) {
        this.negotiateConnection(userId);
      }
    });
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
        offerToReceiveVideo: true,
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

  private async handleSignalingData(data: any) {
    const senderId = parseInt(data.sender);
    const receiverId = parseInt(data.receiver);

    if (isNaN(senderId) || isNaN(receiverId) || receiverId !== parseInt(this.userId)) {
      return;
    }

    if (!this.voiceUserIds.has(senderId) || senderId === parseInt(this.userId)) {
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
    if (!peer || peer.pc.signalingState !== 'have-local-offer') {
      return;
    }

    try {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(data));
    } catch (error) {
      console.error(`[Answer ${userId}] Error handling answer:`, error);
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
      this.trackTypeMap.set(data.trackId, data.streamType);

      const pending = this.pendingTracks.get(userId) || [];
      const remaining: { track: MediaStreamTrack; stream: MediaStream }[] = [];

      pending.forEach(({ track, stream }) => {
        if (track.id === data.trackId) {
          console.log(`[TrackMetadata] Processing pending track ${track.id} for user ${userId}`);
          const peer = this.peerConnections.get(userId);
          if (peer) {
            const current = this.remoteStreams.get(userId) || {};
            let targetStream = current[data.streamType as 'screen' | 'camera'];
            if (!targetStream) {
              targetStream = new MediaStream();
              current[data.streamType as 'screen' | 'camera'] = targetStream;
            }
            targetStream.addTrack(track);
            peer.streams[data.streamType as 'screen' | 'camera'] = track;
            this.remoteStreams.set(userId, current);
            this.updateVideoElements(userId);
          }
        } else {
          remaining.push({ track, stream });
        }
      });

      this.pendingTracks.set(userId, remaining);
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

  leaveCall() {
    this.peerConnections.forEach((_, userId) => this.closePeerConnection(userId));
    this.localStream?.getTracks().forEach(track => track.stop());
    this.screenStream?.getTracks().forEach(track => track.stop());
    this.cameraStream?.getTracks().forEach(track => track.stop());

    this.streamTypeMap.delete(this.localStream!);
    this.streamTypeMap.delete(this.screenStream!);
    this.streamTypeMap.delete(this.cameraStream!);
    this.localStream = undefined;
    this.screenStream = undefined;
    this.cameraStream = undefined;
    this.isInCall = false;
    this.isCameraEnabled = false;
    this.isScreenSharing = false;
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

  private safePlayVideo(element: HTMLVideoElement) {
    if (element.srcObject) {
      element.play().catch(err => {
        if (err.name === 'NotAllowedError') {
          document.addEventListener('click', () => {
            element.play().catch(e => console.error('[Video] Retry play error:', e));
          }, { once: true });
        }
      });
    }
  }

  private debounceChangeDetection() {
    if (this.changeDetectionTimeout) {
      clearTimeout(this.changeDetectionTimeout);
    }
    this.changeDetectionTimeout = setTimeout(() => {
      this.cdr.detectChanges();
    }, 100);
  }
}
