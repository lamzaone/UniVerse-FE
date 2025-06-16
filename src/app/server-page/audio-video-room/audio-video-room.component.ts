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

  peerConnections = new Map<number, PeerConnection>();
  remoteStreams = new Map<number, { camera?: MediaStream, screen?: MediaStream }>();
  pendingCandidates = new Map<number, RTCIceCandidate[]>();

  isInCall = false;
  isScreenSharing = false;
  isCameraEnabled = false;
  isMicMuted = false;

  private changeDetectionTimeout: any;
  private negotiationLock = new Map<number, boolean>();
  private pendingOffers = new Map<number, any>();
  private readonly MAX_RETRIES = 2; // Reduced from 3
  private readonly BASE_RETRY_DELAY = 1000; // Reduced from 2000
  private readonly ICE_CONNECTION_TIMEOUT = 3000; // Reduced from 15000
  private readonly OFFER_COOLDOWN = 1500; // Reduced from 3000
  private readonly INITIAL_CONNECTION_DELAY = 300; // New constant for initial connection delay
  private readonly MAX_PARALLEL_CONNECTIONS = 4; // New constant for parallel connections

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
          if (data.type === 'ice-candidate' || data.type === 'offer' || data.type === 'answer') {
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

      // Skip user info fetch if we're in a hurry to connect
      if (!this.users.find(u => u.id === userId)) {
        this.users.push({ id: userId, name: `User ${userId}`, picture: '' });
        // Fetch user info in background without waiting
        this.userService.getUserInfo(userId.toString()).then(user => {
          const existingUser = this.users.find(u => u.id === userId);
          if (existingUser) {
            Object.assign(existingUser, user);
            this.debounceChangeDetection();
          }
        }).catch(() => { /* ignore errors */ });
      }

      if (this.isInCall) {
        // Use smaller random delay and prioritize connections
        const delay = this.activeConnectionCount < this.MAX_PARALLEL_CONNECTIONS
          ? this.INITIAL_CONNECTION_DELAY
          : this.INITIAL_CONNECTION_DELAY + Math.random() * 1000;

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
      // Keep your existing ICE servers
      { urls: "stun:stun.relay.metered.ca:80" },
      // ... other servers ...
    ],
    iceTransportPolicy: 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceCandidatePoolSize: 5 // Increased candidate pool size
  });

  const peer: PeerConnection = {
    pc,
    streams: {},
    displayName,
    retryCount: 0,
    lastConnectionAttempt: Date.now(), // Set initial attempt time
    lastOfferSent: 0,
    isPolite,
    wasConnected: false,
    connectionTimeout: null,
    reconnectTimer: null,
    lastCandidate: null
  };
  this.peerConnections.set(userId, peer);
  this.pendingCandidates.set(userId, []);

  // Reduced timeout for faster failure detection
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

      console.log(`[Track] Received ${track.kind} track from user ${userId}`);

      const isScreen = track.kind === 'video' &&
                      (track.contentHint === 'detail' ||
                       track.contentHint === 'text' ||
                       stream.id.includes('screen'));

      if (track.kind === 'audio' && userId !== parseInt(this.userId)) {
        this.addAudioElement(userId, stream);
      } else if (track.kind === 'video') {
        const current = this.remoteStreams.get(userId) || {};
        if (isScreen) {
          current.screen = stream;
        } else {
          current.camera = stream;
        }
        this.remoteStreams.set(userId, current);
        this.updateVideoElements(userId);
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
      }, 50 + Math.random() * 150); // Much smaller random delay
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

    if (this.localStream) {
      tracks.push(...this.localStream.getTracks());
    }
    if (this.screenStream) {
      tracks.push(...this.screenStream.getTracks());
    }

    tracks.forEach(track => {
      if (!peer.pc.getSenders().some(s => s.track === track)) {
        peer.pc.addTrack(track, new MediaStream([track]));
      }
    });
  }

  private updateVideoElements(userId: number) {
    const userContainer = this.remoteVideoContainers.find(
      container => (container.nativeElement.closest('.user') as HTMLElement | null)?.dataset.userId === userId.toString()
    )?.nativeElement.querySelector('.remote-video');

    if (!userContainer) return;

    const streams = this.remoteStreams.get(userId) || {};

    // Update camera video
    const existingCameraVideo = userContainer.querySelector(`video.camera-video[data-user-id="${userId}"]`) as HTMLVideoElement;
    if (streams.camera) {
      if (!existingCameraVideo) {
        const cameraVideo = document.createElement('video');
        cameraVideo.classList.add('camera-video');
        cameraVideo.dataset.userId = userId.toString();
        cameraVideo.autoplay = true;
        cameraVideo.playsInline = true;
        cameraVideo.srcObject = streams.camera;
        userContainer.appendChild(cameraVideo);
        this.safePlayVideo(cameraVideo);
      } else if (existingCameraVideo.srcObject !== streams.camera) {
        existingCameraVideo.srcObject = streams.camera;
        this.safePlayVideo(existingCameraVideo);
      }
    } else if (existingCameraVideo) {
      existingCameraVideo.remove();
    }

    // Update screen share video
    const existingScreenVideo = userContainer.querySelector(`video.screen-share[data-user-id="${userId}"]`) as HTMLVideoElement;
    if (streams.screen) {
      if (!existingScreenVideo) {
        const screenVideo = document.createElement('video');
        screenVideo.classList.add('screen-share');
        screenVideo.dataset.userId = userId.toString();
        screenVideo.autoplay = true;
        screenVideo.playsInline = true;
        screenVideo.srcObject = streams.screen;
        userContainer.appendChild(screenVideo);
        this.safePlayVideo(screenVideo);
      } else if (existingScreenVideo.srcObject !== streams.screen) {
        existingScreenVideo.srcObject = streams.screen;
        this.safePlayVideo(existingScreenVideo);
      }
    } else if (existingScreenVideo) {
      existingScreenVideo.remove();
    }

    this.debounceChangeDetection();
  }

  async joinVoiceRoom() {
    if (this.isInCall) return;

    console.log('[Call] Joining voice room');
    try {
      // Start media acquisition in parallel with connection setup
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

      // Start connecting to other users while we're getting our media
      this.users.forEach((user, index) => {
        if (user.id !== parseInt(this.userId) && this.voiceUserIds.has(user.id)) {
          setTimeout(() => {
            if (this.isInCall && this.voiceUserIds.has(user.id)) {
              this.createPeerConnection(user.id);
            }
          }, index * 100); // Small staggered delay based on index
        }
      });

      // Finish media acquisition
      this.localStream = await mediaPromise;

      if (this.localVideoRef?.nativeElement) {
        this.localVideoRef.nativeElement.srcObject = this.localStream;
        this.localVideoRef.nativeElement.muted = true;
        this.safePlayVideo(this.localVideoRef.nativeElement);
      }

      this.voiceUserIds.add(parseInt(this.userId));
      this.fetchInitialUsers(); // Ensure we have the latest user info

      this.debounceChangeDetection();
    } catch (error) {
      console.error('[Call] Error joining call:', error);
      this.isInCall = false;
    }
  }


  async toggleScreenShare() {
    this.isScreenSharing = !this.isScreenSharing;

    if (this.isScreenSharing) {
      try {
        this.screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 30 } },
          audio: false
        });

        this.screenStream.getTracks().forEach(track => {
          track.addEventListener('ended', () => {
            this.toggleScreenShare();
          });
        });

        if (this.localStream) {
          const newStream = new MediaStream([
            ...this.localStream.getAudioTracks(),
            ...this.screenStream.getVideoTracks()
          ]);
          this.localStream.getVideoTracks().forEach(track => track.stop());
          this.localStream = newStream;
          if (this.localVideoRef?.nativeElement) {
            this.localVideoRef.nativeElement.srcObject = this.localStream;
            this.safePlayVideo(this.localVideoRef.nativeElement);
          }
        }
      } catch (err) {
        console.error('[ScreenShare] Failed to share screen:', err);
        this.isScreenSharing = false;
        return;
      }
    } else {
      this.screenStream?.getTracks().forEach(track => track.stop());
      this.screenStream = undefined;

      if (this.isCameraEnabled && this.localStream) {
        try {
          const videoStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { max: 320 }, height: { max: 240 }, frameRate: { max: 30 } }
          });
          this.localStream.getVideoTracks().forEach(track => track.stop());
          const newStream = new MediaStream([
            ...this.localStream.getAudioTracks(),
            ...videoStream.getVideoTracks()
          ]);
          this.localStream = newStream;
          if (this.localVideoRef?.nativeElement) {
            this.localVideoRef.nativeElement.srcObject = this.localStream;
            this.safePlayVideo(this.localVideoRef.nativeElement);
          }
        } catch (error) {
          console.error('[ScreenShare] Failed to restore camera:', error);
          this.localStream = new MediaStream([...this.localStream.getAudioTracks()]);
        }
      } else {
        this.localStream = this.localStream ? new MediaStream([...this.localStream.getAudioTracks()]) : undefined;
        if (this.localVideoRef?.nativeElement) {
          this.localVideoRef.nativeElement.srcObject = this.localStream || null;
        }
      }
    }

    this.peerConnections.forEach((peer, userId) => {
      this.updatePeerTracks(peer);
      if (peer.pc.signalingState === 'stable' && !this.negotiationLock.get(userId)) {
        this.negotiateConnection(userId);
      }
    });

    this.debounceChangeDetection();
  }

  async toggleCamera() {
    this.isCameraEnabled = !this.isCameraEnabled;

    if (this.isCameraEnabled) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { max: 320 }, height: { max: 240 }, frameRate: { max: 30 } }
        });
        if (this.localStream) {
          this.localStream.getVideoTracks().forEach(track => track.stop());
          stream.getVideoTracks().forEach(track => this.localStream!.addTrack(track));
        } else {
          this.localStream = stream;
        }
        if (this.localVideoRef?.nativeElement) {
          this.localVideoRef.nativeElement.srcObject = this.localStream;
          this.safePlayVideo(this.localVideoRef.nativeElement);
        }
      } catch (error) {
        console.error('[Camera] Failed to enable camera:', error);
        this.isCameraEnabled = false;
      }
    } else {
      this.localStream?.getVideoTracks().forEach(track => track.stop());
      if (this.localStream) {
        this.localStream = new MediaStream([...this.localStream.getAudioTracks()]);
      }
      if (this.localVideoRef?.nativeElement) {
        this.localVideoRef.nativeElement.srcObject = this.localStream || null;
      }
    }

    this.peerConnections.forEach((peer, userId) => {
      this.updatePeerTracks(peer);
      if (peer.pc.signalingState === 'stable' && !this.negotiationLock.get(userId)) {
        this.negotiateConnection(userId);
      }
    });

    this.debounceChangeDetection();
  }

  private async negotiateConnection(userId: number) {
    const peer = this.peerConnections.get(userId);
    if (!peer || peer.pc.signalingState !== 'stable' || this.negotiationLock.get(userId)) {
      return;
    }

    // Skip cooldown check for initial offer
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
        iceRestart: peer.retryCount > 0 // Only restart ICE on retries
      });

      // Use setLocalDescription with the offer directly
      await peer.pc.setLocalDescription(offer);
      peer.lastOfferSent = now;

      this.socketService.sendMessage(
        JSON.stringify({
          type: 'offer',
          sender: this.userId,
          receiver: userId,
          sdp: offer.sdp,
          isInitial: peer.retryCount === 0 // Mark initial offers
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
        if (streams.camera) streams.camera.getTracks().forEach(track => track.stop());
        if (streams.screen) streams.screen.getTracks().forEach(track => track.stop());
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
      this.negotiationLock.delete(userId);
      this.pendingOffers.delete(userId);
      this.activeConnectionCount = Math.max(0, this.activeConnectionCount - 1);

    }
  }

  leaveCall() {
    this.peerConnections.forEach((_, userId) => this.closePeerConnection(userId));
    this.localStream?.getTracks().forEach(track => track.stop());
    this.screenStream?.getTracks().forEach(track => track.stop());

    this.localStream = undefined;
    this.screenStream = undefined;
    this.isInCall = false;
    this.isCameraEnabled = false;
    this.isScreenSharing = false;

    if (this.localVideoRef?.nativeElement) {
      this.localVideoRef.nativeElement.srcObject = null;
    }

    this.audioContainerRef.nativeElement.innerHTML = '';
    this.remoteStreams.clear();

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
