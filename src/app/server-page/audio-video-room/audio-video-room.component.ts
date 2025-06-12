import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { UsersService } from '../../services/users.service';
import { AuthService } from '../../services/auth.service';
import { SocketService } from '../../services/socket.service';
import api from '../../services/api.service';
import { screen } from 'electron';

interface PeerConnection {
  pc: RTCPeerConnection;
  streams: {
    audio?: MediaStreamTrack;
    camera?: MediaStreamTrack;
    screen?: MediaStreamTrack;
  };
  displayName: string;
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
  @ViewChild('remoteVideoContainer', { static: false }) remoteVideoRef!: ElementRef<HTMLDivElement>;

  roomId: number = 14;
  userId = this.authService.getUser().id;

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
      // console.log('[Socket] Received message:', message);
      if (message.startsWith('user_joined_call')) {
        const parts = message.split(':&');
        if (parts.length === 2) {
          const userId = parseInt(parts[1]);
          if (!isNaN(userId)) {
            this.handleUserJoined(userId);
          } else {
            console.warn('[Socket] Invalid user ID in user_joined_call:', message);
          }
        } else {
          console.warn('[Socket] Malformed user_joined_call message:', message);
        }
      } else if (message.startsWith('user_left_call')) {
        const parts = message.split(':&');
        if (parts.length === 2) {
          const userId = parseInt(parts[1]);
          if (!isNaN(userId)) {
            this.handleUserLeft(userId);
          } else {
            console.warn('[Socket] Invalid user ID in user_left_call:', message);
          }
        } else {
          console.warn('[Socket] Malformed user_left_call message:', message);
        }
      } else {
        try {
          const data = JSON.parse(message);
          if (data.type === 'user-joined') {
            if (data.user_id && !isNaN(data.user_id)) {
              // this.handleUserJoined(data.user_id);
            } else {
              console.warn('[Socket] Invalid user ID in user-joined:', data);
            }
          } else {
            this.handleSignalingData(data);
          }
        } catch {
          console.log('[Socket] Non-JSON message:', message);
        }
      }
      this.debounceChangeDetection();
    });
  }

  private handleUserJoined(userId: number) {
    if (!this.voiceUserIds.has(userId) && userId !== this.userId) {
      console.log(`[User] User ${userId} joined`);
      this.voiceUserIds.add(userId);
      if (this.isInCall) {
        setTimeout(() => this.createPeerConnection(userId), 500);
      }
      this.fetchInitialUsers();
      this.debounceChangeDetection();
    }
  }

  private handleUserLeft(userId: number) {
    console.log(`[User] User ${userId} left`);
    this.voiceUserIds.delete(userId);
    this.closePeerConnection(userId);
    this.fetchInitialUsers();
    this.debounceChangeDetection();
  }

  private createPeerConnection(userId: number): void {
    if (this.peerConnections.has(userId)) {
      console.log(`[Peer] Replacing existing connection for user ${userId}`);
      this.closePeerConnection(userId);
    }

    const user = this.users.find(u => u.id === userId);
    const displayName = user?.name || `User ${userId}`;

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
      ]
    });

    const peer: PeerConnection = { pc, streams: {}, displayName };
    this.peerConnections.set(userId, peer);
    this.pendingCandidates.set(userId, []);

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

      console.log(`[Track] Received ${track.kind} track from user ${userId}`, track);

      // Better screen share detection
      const isScreen = track.kind === 'video' &&
                      (track.contentHint === 'detail' ||
                       track.contentHint === 'text' ||
                       stream.id.includes('screen') ||
                       stream.id.includes('desktop'));

      if (track.kind === 'audio' && userId !== this.userId) {
        // Audio handling remains the same
        const audio = document.createElement('audio');
        audio.srcObject = stream;
        audio.autoplay = true;
        audio.dataset.userId = userId.toString();
        this.audioContainerRef.nativeElement.appendChild(audio);
      } else if (track.kind === 'video') {
        const current = this.remoteStreams.get(userId) || {};
        if (isScreen) {
          current.screen = stream;
          console.log(`[Screen] Detected screen share from user ${userId}`);
        } else {
          current.camera = stream;
        }
        this.remoteStreams.set(userId, current);
        this.updateVideoElements(userId);
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[Connection] State with user ${userId}: ${pc.connectionState}`);

      switch(pc.connectionState) {
        case 'connected':
          // Connection is ready
          break;
        case 'disconnected':
        case 'failed':
          // Attempt reconnection
          setTimeout(() => this.reconnectPeer(userId), 1000);
          break;
        case 'closed':
          // Clean up
          this.closePeerConnection(userId);
          break;
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[ICE] Connection state with user ${userId}: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'failed') {
        this.reconnectPeer(userId);
      }
    };

    pc.onsignalingstatechange = () => {
      console.log(`[Signaling] State for user ${userId}: ${pc.signalingState}`);
      if (pc.signalingState === 'stable' && this.pendingCandidates.get(userId)?.length) {
        const pending = this.pendingCandidates.get(userId) || [];
        pending.forEach(c => {
          console.log(`[ICE] Applying queued candidate for user ${userId}`);
          pc.addIceCandidate(c).catch(e => console.error('[ICE] Error adding candidate:', e));
        });
        this.pendingCandidates.set(userId, []);
      }
      if (pc.signalingState === 'stable' && this.pendingOffers.has(userId)) {
        const offer = this.pendingOffers.get(userId);
        this.pendingOffers.delete(userId);
        console.log(`[Offer] Processing queued offer for user ${userId}`);
        this.handleOffer(userId, offer);
      }
    };

    this.updatePeerTracks(peer);

    if (!this.pendingOffers.has(userId)) {
      console.log(`[Peer] Initiating negotiation with user ${userId}`);
      this.negotiateConnection(userId);
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
        console.log(`[Track] Adding ${track.kind} track to peer ${peer.displayName}`);
        peer.pc.addTrack(track, new MediaStream([track]));
      }
    });
  }

  private updateVideoElements(userId: number) {
    const container = this.remoteVideoRef.nativeElement;
    const streams = this.remoteStreams.get(userId) || {};

    // Remove all existing video elements for this user
    const existingVideos = container.querySelectorAll(`video[data-user-id="${userId}"]`);
    existingVideos.forEach(video => video.remove());

    // Create new video elements as needed
    if (streams.camera) {
      const cameraVideo = document.createElement('video');
      cameraVideo.classList.add('camera-video');
      cameraVideo.dataset.userId = userId.toString();
      cameraVideo.autoplay = true;
      cameraVideo.playsInline = true;
      cameraVideo.srcObject = streams.camera;
      container.appendChild(cameraVideo);
      this.safePlayVideo(cameraVideo);
    }

    if (streams.screen) {
      const screenVideo = document.createElement('video');
      screenVideo.classList.add('screen-share');
      screenVideo.dataset.userId = userId.toString();
      screenVideo.autoplay = true;
      screenVideo.playsInline = true;
      screenVideo.srcObject = streams.screen;
      container.appendChild(screenVideo);
      this.safePlayVideo(screenVideo);
    }

    this.debounceChangeDetection();
  }

  async joinVoiceRoom() {
    if (this.isInCall) return;

    console.log('[Call] Joining voice room');
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: this.isCameraEnabled ? { width: { max: 320 }, height: { max: 240 }, frameRate: { max: 30 } } : false
      });

      if (this.localVideoRef?.nativeElement) {
        console.log('[Video] Setting local video stream');
        this.localVideoRef.nativeElement.srcObject = this.localStream;
        this.localVideoRef.nativeElement.muted = true;
        this.safePlayVideo(this.localVideoRef.nativeElement);
      }

      this.isInCall = true;
      this.socketService.sendMessage(`user_joined_call:&${this.userId}`, false, 'audioRoom');

      this.users.forEach(user => {
        if (user.id !== this.userId) {
          console.log(`[Peer] Creating connection for user ${user.id}`);
          this.createPeerConnection(user.id);
        }
      });

      this.debounceChangeDetection();
    } catch (error) {
      console.error('[Call] Error joining call:', error);
      this.isInCall = false;
      alert('Could not access microphone/camera');
    }
  }

  async toggleScreenShare() {
    console.log('[ScreenShare] Toggling screen share:', !this.isScreenSharing);
    this.isScreenSharing = !this.isScreenSharing;

    if (this.isScreenSharing) {
      try {
        this.screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: { max: 320 }, height: { max: 240 }, frameRate: { max: 30 } },
          audio: false
        });
        this.screenStream.getVideoTracks()[0].contentHint = 'detail';

        this.screenStream.getTracks().forEach(track => {
          track.addEventListener('ended', () => {
            console.log('[ScreenShare] Screen share ended');
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
            console.log('[Video] Updating local video to screen share');
            this.localVideoRef.nativeElement.srcObject = this.localStream;
            this.safePlayVideo(this.localVideoRef.nativeElement);
          }
        }
      } catch (err) {
        console.error('[ScreenShare] Failed to share screen:', err);
        this.isScreenSharing = false;
        alert('Screen sharing failed. Please try again.');
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
            console.log('[Video] Restoring local video to camera');
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
          console.log('[Video] Clearing local video');
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
    console.log('[Camera] Toggling camera:', !this.isCameraEnabled);
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
          console.log('[Video] Setting local video to camera');
          this.localVideoRef.nativeElement.srcObject = this.localStream;
          this.safePlayVideo(this.localVideoRef.nativeElement);
        }
      } catch (error) {
        console.error('[Camera] Failed to enable camera:', error);
        this.isCameraEnabled = false;
        alert('Could not access camera');
      }
    } else {
      this.localStream?.getVideoTracks().forEach(track => track.stop());
      if (this.localStream) {
        this.localStream = new MediaStream([...this.localStream.getAudioTracks()]);
      }
      if (this.localVideoRef?.nativeElement) {
        console.log('[Video] Clearing local video');
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
      console.log(`[Negotiation] Skipping for user ${userId}, state: ${peer?.pc.signalingState}, locked: ${this.negotiationLock.get(userId)}`);
      return;
    }

    this.negotiationLock.set(userId, true);
    try {
      console.log(`[Negotiation] Creating offer for user ${userId}`);
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      this.socketService.sendMessage(
        JSON.stringify({
          type: 'offer',
          sender: this.userId,
          receiver: userId,
          sdp: offer.sdp
        }),
        false,
        'audioRoom'
      );
    } catch (error) {
      console.error('[Negotiation] Error:', error);
    } finally {
      this.negotiationLock.set(userId, false);
    }
  }

  private async handleSignalingData(data: any) {
    const senderId = parseInt(data.sender);
    const receiverId = parseInt(data.receiver);

    if (isNaN(senderId) || isNaN(receiverId)) {
      console.log('[Signaling] Ignoring message with invalid sender or receiver:', data);
      return;
    }

    if (receiverId !== this.userId) {
      console.log(`[Signaling] Ignoring message not addressed to user ${this.userId}:`, data);
      return;
    }

    if (!this.voiceUserIds.has(senderId) || senderId === this.userId) {
      console.log(`[Signaling] Ignoring message from invalid or self sender ${senderId}:`, data);
      return;
    }

    console.log(`[Signaling] Handling ${data.type} from user ${senderId} to user ${receiverId}`);
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
      default:
        console.warn(`[Signaling] Unknown message type: ${data.type}`);
    }
  }

  private async handleOffer(userId: number, data: any) {
    let peer = this.peerConnections.get(userId);
    if (!peer) {
      console.log(`[Offer ${userId}] Creating new peer connection`);
      this.createPeerConnection(userId);
      peer = this.peerConnections.get(userId);
    }
    if (!peer) {
      console.error(`[Offer ${userId}] Failed to create peer connection`);
      return;
    }

    if (this.negotiationLock.get(userId)) {
      console.log(`[Offer ${userId}] Negotiation locked, queuing offer`);
      this.pendingOffers.set(userId, data);
      return;
    }

    this.negotiationLock.set(userId, true);
    try {
      if (peer.pc.signalingState !== 'stable') {
        console.warn(`[Offer ${userId}] Not in stable state: ${peer.pc.signalingState}`);
        if (peer.pc.signalingState === 'have-local-offer') {
          console.log(`[Offer ${userId}] Rolling back local offer`);
          await peer.pc.setLocalDescription({ type: 'rollback' });
        }
      }

      console.log(`[Offer ${userId}] Setting remote description`);
      await peer.pc.setRemoteDescription(new RTCSessionDescription(data));
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
    } finally {
      this.negotiationLock.set(userId, false);
    }
  }

  private async handleAnswer(userId: number, data: any) {
    const peer = this.peerConnections.get(userId);
    if (!peer) {
      console.warn(`[Answer ${userId}] No peer connection`);
      return;
    }

    try {
      if (peer.pc.signalingState !== 'have-local-offer') {
        console.warn(`[Answer ${userId}] Invalid state: ${peer.pc.signalingState}`);
        if (peer.pc.signalingState === 'stable') {
          console.log(`[Answer ${userId}] Attempting renegotiation`);
          this.negotiateConnection(userId);
        }
        return;
      }
      console.log(`[Answer ${userId}] Setting remote description`);
      await peer.pc.setRemoteDescription(new RTCSessionDescription(data));
    } catch (error) {
      console.error(`[Answer ${userId}] Error handling answer:`, error);
    }
  }

  private async handleCandidate(userId: number, candidate: any) {
    const peer = this.peerConnections.get(userId);
    if (!peer) {
      console.warn(`[ICE ${userId}] No peer connection`);
      return;
    }

    const rtcCandidate = new RTCIceCandidate(candidate);
    if (peer.pc.remoteDescription && peer.pc.signalingState !== 'closed') {
      console.log(`[ICE ${userId}] Adding candidate`);
      await peer.pc.addIceCandidate(rtcCandidate).catch(error => console.error(`[ICE ${userId}] Error adding candidate:`, error));
    } else {
      console.log(`[ICE ${userId}] Queuing candidate`);
      const pending = this.pendingCandidates.get(userId) || [];
      pending.push(rtcCandidate);
      this.pendingCandidates.set(userId, pending);
    }
  }

  private closePeerConnection(userId: number) {
    const peer = this.peerConnections.get(userId);
    if (peer) {
      console.log(`[Peer ${userId}] Closing connection`);

      // Don't close the connection immediately - first check states
      if (peer.pc.connectionState !== 'closed') {
        peer.pc.close();
      }

      // Clean up streams for this user only
      this.remoteStreams.delete(userId);

      // Remove only elements related to this user
      const audioElements = this.audioContainerRef.nativeElement.querySelectorAll(`audio[data-user-id="${userId}"]`);
      audioElements.forEach((audio: Element) => {
        (audio as HTMLAudioElement).srcObject = null;
        audio.remove();
      });

      const videoContainer = this.remoteVideoRef?.nativeElement;
      if (videoContainer) {
        const userVideos = videoContainer.querySelectorAll(`video[data-user-id="${userId}"]`);
        userVideos.forEach(video => video.remove());
      }

      // Only then remove from maps
      this.peerConnections.delete(userId);
      this.pendingCandidates.delete(userId);
      this.negotiationLock.delete(userId);
      this.pendingOffers.delete(userId);
    }
  }

  private reconnectPeer(userId: number) {
    console.log(`[Peer] Attempting to reconnect to user ${userId}`);

    // Only reconnect if we're still in call and user is still connected
    if (this.isInCall && this.voiceUserIds.has(userId)) {
      // Close existing connection cleanly
      this.closePeerConnection(userId);

      // Add delay before reconnecting
      setTimeout(() => {
        if (this.isInCall && this.voiceUserIds.has(userId)) {
          console.log(`[Peer] Creating new connection for user ${userId}`);
          this.createPeerConnection(userId);
        }
      }, 1000 + Math.random() * 2000); // Random delay to avoid thundering herd
    }
  }

  leaveCall() {
    console.log('[Call] Leaving voice');
    this.peerConnections.forEach((_, userId) => this.closePeerConnection(userId));
    this.localStream?.getTracks().forEach(track => track.stop());
    this.screenStream?.getTracks().forEach(track => track.stop());

    this.localStream = undefined;
    this.screenStream = undefined;
    this.isInCall = false;
    this.isCameraEnabled = false;
    this.isScreenSharing = false;

    if (this.localVideoRef?.nativeElement) {
      console.log('[Video] Cleaning up local video');
      this.localVideoRef.nativeElement.srcObject = null;
    }

    this.audioContainerRef.nativeElement.innerHTML = '';

    this.socketService.sendMessage(`user_left_call:&${this.userId}`, false, 'audioRoom');
    this.debounceChangeDetection();
  }

  toggleMic() {
    console.log('[Mic] Toggling mute:', !this.isMicMuted);
    this.isMicMuted = !this.isMicMuted;
    this.localStream?.getTracks().forEach(track => {
      if (track.kind === 'audio') {
        track.enabled = !this.isMicMuted;
        console.log(`[Mic] Audio track ${track.id} enabled: ${track.enabled}`);
      }
    });
    this.debounceChangeDetection();
  }

  private safePlayVideo(element: HTMLVideoElement) {
    if (element.srcObject) {
      element.play().catch(err => {
        console.error('[Video] Play error:', err);
        if (err.name === 'NotAllowedError') {
          console.warn('[Video] Autoplay blocked, waiting for user interaction');
          document.addEventListener('click', () => {
            element.play().catch(e => console.error('[Video] Retry play error:', e));
          }, { once: true });
        } else if (err.name === 'AbortError') {
          console.warn('[Video] Playback aborted, retrying after delay');
          setTimeout(() => this.safePlayVideo(element), 100);
        }
      });
    }
  }

  private debounceChangeDetection() {
    if (this.changeDetectionTimeout) {
      clearTimeout(this.changeDetectionTimeout);
    }
    this.changeDetectionTimeout = setTimeout(() => {
      console.log('[CD] Triggering change detection');
      this.cdr.detectChanges();
    }, 100);
  }
}
