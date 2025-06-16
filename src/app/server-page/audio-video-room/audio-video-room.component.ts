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
  connectionStartTime: number;
  makingOffer: boolean;
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
  pendingSignalingMessages: Map<number, any[]> = new Map();

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
  private connectionQueue: number[] = [];
  private readonly MAX_RETRIES = 3;
  private readonly BASE_RETRY_DELAY = 1000;
  private readonly ICE_CONNECTION_TIMEOUT = 7000; // Increased to 7s
  private readonly OFFER_COOLDOWN = 2000;
  private readonly INITIAL_CONNECTION_DELAY = 500;
  private readonly MAX_PARALLEL_CONNECTIONS = 3;
  private readonly STABLE_CONNECTION_THRESHOLD = 3000;

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
      this.processPendingSignalingMessages();
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
            console.log(`[Socket] Received signaling message: type=${data.type}, sender=${data.sender}, receiver=${data.receiver}`);
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
            this.processPendingSignalingMessages(userId);
            this.debounceChangeDetection();
          }
        }).catch(() => {});
      }

      this.processPendingSignalingMessages(userId);

      if (this.isInCall && !this.connectionQueue.includes(userId)) {
        this.connectionQueue.push(userId);
        this.processConnectionQueue();
      }
      this.debounceChangeDetection();
    }
  }

  private handleUserLeft(userId: number) {
    console.log(`[User] User ${userId} left`);
    this.voiceUserIds.delete(userId);
    this.connectionQueue = this.connectionQueue.filter(id => id !== userId);
    this.pendingSignalingMessages.delete(userId);
    this.closePeerConnection(userId);
    this.users = this.users.filter(u => u.id !== userId);
    this.debounceChangeDetection();
  }

  private processPendingSignalingMessages(userId?: number) {
    if (userId) {
      const messages = this.pendingSignalingMessages.get(userId) || [];
      console.log(`[Signaling] Processing ${messages.length} pending messages for user ${userId}`);
      messages.forEach(data => this.handleSignalingData(data));
      this.pendingSignalingMessages.delete(userId);
    } else {
      this.pendingSignalingMessages.forEach((messages, id) => {
        if (this.voiceUserIds.has(id)) {
          console.log(`[Signaling] Processing ${messages.length} pending messages for user ${id}`);
          messages.forEach(data => this.handleSignalingData(data));
          this.pendingSignalingMessages.delete(id);
        }
      });
    }
  }

  private processConnectionQueue() {
    if (this.activeConnectionCount >= this.MAX_PARALLEL_CONNECTIONS || !this.connectionQueue.length) {
      return;
    }

    const userId = this.connectionQueue.shift();
    if (!userId || !this.isInCall || !this.voiceUserIds.has(userId)) {
      return;
    }

    const delay = this.INITIAL_CONNECTION_DELAY + (Math.random() * 50);
    setTimeout(() => {
      if (this.isInCall && this.voiceUserIds.has(userId)) {
        this.createPeerConnection(userId);
      }
      this.processConnectionQueue();
    }, delay);
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
        { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
        { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
      ],
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 10
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
      connectionStartTime: Date.now(),
      makingOffer: false
    };
    this.peerConnections.set(userId, peer);
    this.pendingCandidates.set(userId, []);

    peer.connectionTimeout = setTimeout(() => {
      if (pc.connectionState !== 'connected' && pc.connectionState !== 'connecting') {
        console.warn(`[Connection] Timeout for user ${userId}`);
        this.scheduleReconnect(userId);
      }
    }, this.ICE_CONNECTION_TIMEOUT);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const candidateString = JSON.stringify(event.candidate);
        if (peer.lastCandidate === candidateString) return;
        peer.lastCandidate = candidateString;

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
          this.startStabilityCheck(userId);
          break;
        case 'disconnected':
        case 'failed':
          this.activeConnectionCount--;
          if (peer.wasConnected && Date.now() - peer.connectionStartTime > this.STABLE_CONNECTION_THRESHOLD) {
            this.scheduleReconnect(userId);
          }
          break;
        case 'closed':
          this.activeConnectionCount--;
          this.closePeerConnection(userId);
          break;
      }
      this.processConnectionQueue();
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[ICE] Connection state with user ${userId}: ${pc.iceConnectionState}`);
      if ((pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') &&
          Date.now() - peer.connectionStartTime > this.STABLE_CONNECTION_THRESHOLD) {
        this.scheduleReconnect(userId);
      }
    };

    pc.onsignalingstatechange = () => {
      console.log(`[Signaling] State for user ${userId}: ${pc.signalingState}`);
      if (pc.signalingState === 'stable') {
        peer.makingOffer = false;
        const pending = this.pendingCandidates.get(userId) || [];
        while (pending.length > 0) {
          const candidate = pending.shift();
          if (candidate) {
            pc.addIceCandidate(candidate).catch(e => console.error('[ICE] Error adding candidate:', e));
          }
        }
        this.pendingCandidates.set(userId, []);
        const pendingOffer = this.pendingOffers.get(userId);
        if (pendingOffer) {
          this.handleOffer(userId, pendingOffer);
        }
      }
    };

    this.updatePeerTracks(peer);

    if (!peer.isPolite && this.isInCall) {
      setTimeout(() => {
        if (this.peerConnections.has(userId)) {
          this.negotiateConnection(userId);
        }
      }, this.INITIAL_CONNECTION_DELAY);
    }
  }

  private startStabilityCheck(userId: number) {
    const peer = this.peerConnections.get(userId);
    if (!peer) return;

    setTimeout(() => {
      if (this.peerConnections.has(userId) && peer.pc.connectionState === 'connected') {
        console.log(`[Connection] Stable connection confirmed with user ${userId}`);
        peer.wasConnected = true;
      }
    }, this.STABLE_CONNECTION_THRESHOLD);
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
      if (this.isInCall && this.voiceUserIds.has(userId) && !this.connectionQueue.includes(userId)) {
        this.connectionQueue.push(userId);
        this.processConnectionQueue();
      }
    }, delay);
  }

  private getRetryDelay(attempt: number): number {
    const base = this.BASE_RETRY_DELAY * Math.pow(1.5, attempt);
    return Math.min(base * (0.8 + Math.random() * 0.4), 5000);
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

    const senders = peer.pc.getSenders();
    const trackIds = new Set(tracks.map(track => track.id));

    // Update or add tracks
    for (const track of tracks) {
      const existingSender = senders.find(sender => sender.track && sender.track.id === track.id);
      if (existingSender) {
        if (existingSender.track !== track) {
          console.log(`[Track] Replacing track ${track.kind} for peer ${peer.displayName}`);
          existingSender.replaceTrack(track).catch(e => console.error(`[Track] Error replacing track:`, e));
        }
      } else {
        const sameKindSender = senders.find(sender => sender.track && sender.track.kind === track.kind);
        if (sameKindSender) {
          console.log(`[Track] Replacing existing ${track.kind} track for peer ${peer.displayName}`);
          sameKindSender.replaceTrack(track).catch(e => console.error(`[Track] Error replacing track:`, e));
        } else {
          console.log(`[Track] Adding new ${track.kind} track for peer ${peer.displayName}`);
          try {
            peer.pc.addTrack(track, new MediaStream([track]));
          } catch (e) {
            console.error(`[Track] Error adding track:`, e);
          }
        }
      }
    }

    // Remove senders for tracks that are no longer present
    for (const sender of senders) {
      if (sender.track && !trackIds.has(sender.track.id)) {
        console.log(`[Track] Removing sender for track ${sender.track.kind} for peer ${peer.displayName}`);
        try {
          peer.pc.removeTrack(sender);
        } catch (e) {
          console.error(`[Track] Error removing sender:`, e);
        }
      }
    }
  }

  private updateVideoElements(userId: number) {
    const userContainer = this.remoteVideoContainers.find(
      container => (container.nativeElement.closest('.user') as HTMLElement | null)?.dataset.userId === userId.toString()
    )?.nativeElement.querySelector('.remote-video');

    if (!userContainer) return;

    const streams = this.remoteStreams.get(userId) || {};

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

      this.connectionQueue = this.users
        .filter(user => user.id !== parseInt(this.userId) && this.voiceUserIds.has(user.id))
        .map(user => user.id);
      this.processConnectionQueue();

      this.localStream = await mediaPromise;

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
      if (peer.pc.signalingState === 'stable' && !this.negotiationLock.get(userId) && !peer.makingOffer) {
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
      if (peer.pc.signalingState === 'stable' && !this.negotiationLock.get(userId) && !peer.makingOffer) {
        this.negotiateConnection(userId);
      }
    });

    this.debounceChangeDetection();
  }

  private async negotiateConnection(userId: number) {
    const peer = this.peerConnections.get(userId);
    if (!peer || peer.pc.signalingState !== 'stable' || this.negotiationLock.get(userId) || peer.makingOffer) {
      console.log(`[Negotiation] Skipping offer for ${userId}: state=${peer?.pc.signalingState}, lock=${this.negotiationLock.get(userId)}, makingOffer=${peer?.makingOffer}`);
      return;
    }

    const now = Date.now();
    if (peer.lastOfferSent > 0 && now - peer.lastOfferSent < this.OFFER_COOLDOWN) {
      setTimeout(() => this.negotiateConnection(userId), this.OFFER_COOLDOWN - (now - peer.lastOfferSent));
      return;
    }

    this.negotiationLock.set(userId, true);
    peer.makingOffer = true;
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
      console.error(`[Negotiation] Error creating offer for ${userId}:`, error);
      this.scheduleReconnect(userId);
    } finally {
      peer.makingOffer = false;
      this.negotiationLock.set(userId, false);
    }
  }

  private async handleSignalingData(data: any) {
    const senderId = parseInt(data.sender);
    const receiverId = parseInt(data.receiver);

    if (isNaN(senderId) || isNaN(receiverId) || receiverId !== parseInt(this.userId)) {
      console.log(`[Signaling] Ignoring invalid message: sender=${senderId}, receiver=${receiverId}, type=${data.type}, reason=invalid_ids`);
      return;
    }

    if (!this.voiceUserIds.has(senderId) || senderId === parseInt(this.userId)) {
      console.log(`[Signaling] Buffering message from ${senderId} (type=${data.type}) as user not yet registered`);
      const pending = this.pendingSignalingMessages.get(senderId) || [];
      pending.push(data);
      this.pendingSignalingMessages.set(senderId, pending);
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
      console.log(`[Offer] Creating new peer connection for user ${userId}`);
      this.createPeerConnection(userId);
      peer = this.peerConnections.get(userId);
    }
    if (!peer || this.negotiationLock.get(userId)) {
      console.log(`[Offer] Queuing offer for ${userId} due to lock or no peer`);
      this.pendingOffers.set(userId, data);
      setTimeout(() => {
        if (this.pendingOffers.has(userId)) {
          this.handleOffer(userId, this.pendingOffers.get(userId));
        }
      }, 500);
      return;
    }

    this.negotiationLock.set(userId, true);
    try {
      const sdp = new RTCSessionDescription({ type: 'offer', sdp: data.sdp });
      const ignoreOffer = !peer.isPolite && (peer.makingOffer || peer.pc.signalingState === 'have-local-offer');

      if (ignoreOffer) {
        console.log(`[Offer] Ignoring offer from ${userId} due to collision (makingOffer=${peer.makingOffer}, signalingState=${peer.pc.signalingState}, isPolite=${peer.isPolite})`);
        return;
      }

      if (peer.pc.signalingState !== 'stable') {
        if (peer.isPolite) {
          console.log(`[Offer] Polite peer rolling back for ${userId}`);
          await peer.pc.setLocalDescription({ type: 'rollback' });
        } else {
          console.log(`[Offer] Ignoring offer for ${userId} in non-stable state: ${peer.pc.signalingState}`);
          return;
        }
      }

      console.log(`[Offer] Accepting offer from ${userId}`);
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
      this.pendingOffers.delete(userId);
    }
  }

  private async handleAnswer(userId: number, data: any) {
    const peer = this.peerConnections.get(userId);
    if (!peer) {
      console.log(`[Answer] No peer connection for user ${userId}`);
      return;
    }

    if (peer.pc.signalingState !== 'have-local-offer') {
      console.warn(`[Answer] Invalid state for answer from ${userId}: ${peer.pc.signalingState}, scheduling rollback`);
      if (peer.pc.signalingState === 'stable') {
        this.negotiateConnection(userId);
      }
      return;
    }

    try {
      console.log(`[Answer] Processing answer from ${userId}`);
      await peer.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.sdp }));
    } catch (error) {
      console.error(`[Answer ${userId}] Error handling answer:`, error);
      this.scheduleReconnect(userId);
    }
  }

  private async handleCandidate(userId: number, candidate: any) {
    const peer = this.peerConnections.get(userId);
    if (!peer) {
      console.log(`[ICE] No peer connection for user ${userId}`);
      return;
    }

    const candidateString = JSON.stringify(candidate);
    if (peer.lastCandidate === candidateString) {
      console.log(`[ICE] Ignoring duplicate candidate from ${userId}`);
      return;
    }
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
      // Remove all senders explicitly
      const senders = peer.pc.getSenders();
      senders.forEach(sender => {
        try {
          peer.pc.removeTrack(sender);
        } catch (e) {
          console.error(`[Close] Error removing sender for user ${userId}:`, e);
        }
      });

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
      this.processConnectionQueue();
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
    this.connectionQueue = [];
    this.pendingSignalingMessages.clear();

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
