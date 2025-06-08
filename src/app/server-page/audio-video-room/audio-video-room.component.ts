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
        const userId = parseInt(message.split(':&')[1]);
        this.handleUserJoined(userId);
      } else if (message.startsWith('user_left_call')) {
        const userId = parseInt(message.split(':&')[1]);
        this.handleUserLeft(userId);
      } else {
        try {
          const data = JSON.parse(message);
          this.handleSignalingData(data);
        } catch {
          console.log('[Socket] Non-JSON message:', message);
        }
      }
      this.debounceChangeDetection();
    });
  }

  private handleUserJoined(userId: number) {
    if (!this.voiceUserIds.has(userId)) {
      console.log(`[User] User ${userId} joined`);
      this.voiceUserIds.add(userId);
      if (this.isInCall) {
        this.createPeerConnection(userId);
      }
      this.fetchInitialUsers();
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
            target: userId,
            candidate: event.candidate,
            sender: this.userId
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

      if (track.kind === 'audio' && userId !== this.userId) {
        const audio = document.createElement('audio');
        audio.srcObject = stream;
        audio.autoplay = true;
        this.audioContainerRef.nativeElement.appendChild(audio);
        console.log(`[Audio] Added audio element for user ${userId}`);
      } else if (track.kind === 'video') {
        const isScreen = track.contentHint === 'detail';
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
      console.log(`[ICE] Connection state with user ${userId}: ${pc.connectionState}`);
      if (["disconnected", "failed"].includes(pc.connectionState)) {
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
    };

    this.updatePeerTracks(peer);

    if (this.userId < userId) {
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
    console.log(`[Video] Updating video elements for user ${userId}, container children: ${container.children.length}`);
    const streams = this.remoteStreams.get(userId) || {};

    const cameraVideo = container.querySelector<HTMLVideoElement>(
      `video.camera-video[data-user-id="${userId}"]`
    );
    if (cameraVideo) {
      console.log(`[Video] Updating camera video for user ${userId}, stream: ${streams.camera ? 'present' : 'null'}`);
      cameraVideo.srcObject = streams.camera || null;
      this.safePlayVideo(cameraVideo);
    } else {
      console.warn(`[Video] Camera video element not found for user ${userId}`);
    }

    const screenVideo = container.querySelector<HTMLVideoElement>(
      `video.screen-share[data-user-id="${userId}"]`
    );
    if (screenVideo) {
      console.log(`[Video] Updating screen-share video for user ${userId}, stream: ${streams.screen ? 'present' : 'null'}`);
      screenVideo.srcObject = streams.screen || null;
      this.safePlayVideo(screenVideo);
    } else {
      console.warn(`[Video] Screen-share video element not found for user ${userId}`);
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
        JSON.stringify({ type: 'offer', target: userId, sdp: peer.pc.localDescription!.sdp, sender: this.userId }),
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
    const userId = data.sender || data.target;
    if (!userId || userId === this.userId) return;

    console.log(`[Signaling] Handling ${data.type} for user ${userId}`);
    switch (data.type) {
      case 'offer':
        await this.handleOffer(userId, data);
        break;
      case 'answer':
        await this.handleAnswer(userId, data);
        break;
      case 'ice-candidate':
        await this.handleCandidate(userId, data.candidate);
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
    if (!peer) return;

    if (this.negotiationLock.get(userId)) {
      console.log(`[Offer] Negotiation locked for user ${userId}, queuing offer`);
      setTimeout(() => this.handleOffer(userId, data), 100);
      return;
    }

    this.negotiationLock.set(userId, true);
    try {
      if (peer.pc.signalingState !== 'stable') {
        console.warn(`[Offer] Peer ${userId} is not stable, resetting connection`);
        await peer.pc.setLocalDescription({ type: 'rollback' });
      }

      console.log(`[Offer] Setting remote description for user ${userId}`);
      await peer.pc.setRemoteDescription(new RTCSessionDescription(data));
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      this.socketService.sendMessage(
        JSON.stringify({ type: 'answer', target: userId, sdp: answer.sdp, sender: this.userId }),
        false,
        'audioRoom'
      );
    } catch (error) {
      console.error('[Offer] Error handling offer:', error);
    } finally {
      this.negotiationLock.set(userId, false);
    }
  }

  private async handleAnswer(userId: number, data: any) {
    const peer = this.peerConnections.get(userId);
    if (!peer) {
      console.warn(`[Answer] No peer connection for user ${userId}`);
      return;
    }

    try {
      if (peer.pc.signalingState !== 'have-local-offer') {
        console.warn(`[Answer] Invalid signaling state ${peer.pc.signalingState} for answer from ${userId}`);
        return;
      }
      console.log(`[Answer] Setting remote description for user ${userId}`);
      await peer.pc.setRemoteDescription(new RTCSessionDescription(data));
    } catch (error) {
      console.error('[Answer] Error handling answer:', error);
    }
  }

  private async handleCandidate(userId: number, candidate: any) {
    const peer = this.peerConnections.get(userId);
    const rtcCandidate = new RTCIceCandidate(candidate);

    if (peer && peer.pc.remoteDescription && peer.pc.signalingState !== 'closed') {
      console.log(`[ICE] Adding candidate for user ${userId}`);
      await peer.pc.addIceCandidate(rtcCandidate).catch(e => console.error('[ICE] Error adding candidate:', e));
    } else {
      console.log(`[ICE] Queuing candidate for user ${userId}`);
      const pending = this.pendingCandidates.get(userId) || [];
      pending.push(rtcCandidate);
      this.pendingCandidates.set(userId, pending);
    }
  }

  private closePeerConnection(userId: number) {
    const peer = this.peerConnections.get(userId);
    if (peer) {
      console.log(`[Peer] Closing connection with user ${userId}`);
      peer.pc.close();
      this.peerConnections.delete(userId);
      this.remoteStreams.delete(userId);
      this.pendingCandidates.delete(userId);
      this.negotiationLock.delete(userId);

      const container = this.remoteVideoRef.nativeElement;
      const cameraVideo = container.querySelector(`video.camera-video[data-user-id="${userId}"]`);
      const screenVideo = container.querySelector(`video.screen-share[data-user-id="${userId}"]`);
      if (cameraVideo) (cameraVideo as HTMLVideoElement).srcObject = null;
      if (screenVideo) (screenVideo as HTMLVideoElement).srcObject = null;
    }
  }

  private reconnectPeer(userId: number) {
    console.log(`[Peer] Reconnecting to user ${userId}`);
    this.closePeerConnection(userId);
    if (this.isInCall && this.voiceUserIds.has(userId)) {
      this.createPeerConnection(userId);
    }
  }

  leaveCall() {
    console.log('[Call] Leaving voice call');
    this.peerConnections.forEach((_, userId) => this.closePeerConnection(userId));
    this.localStream?.getTracks().forEach(track => track.stop());
    this.screenStream?.getTracks().forEach(track => track.stop());

    this.localStream = undefined;
    this.screenStream = undefined;
    this.isInCall = false;
    this.isCameraEnabled = false;
    this.isScreenSharing = false;
    if (this.localVideoRef?.nativeElement) {
      console.log('[Video] Clearing local video');
      this.localVideoRef.nativeElement.srcObject = null;
    }

    this.socketService.sendMessage(`user_left_call:&${this.userId}`, false, 'audioRoom');
    this.debounceChangeDetection();
  }

  toggleMic() {
    console.log('[Mic] Toggling mute:', !this.isMicMuted);
    this.isMicMuted = !this.isMicMuted;
    this.localStream?.getAudioTracks().forEach(track => {
      track.enabled = !this.isMicMuted;
      console.log(`[Mic] Audio track enabled: ${track.enabled}`);
    });
    this.debounceChangeDetection();
  }

  private safePlayVideo(element: HTMLVideoElement) {
    element.play().catch(err => {
      console.error('[Video] Play error:', err);
      if (err.name === 'NotAllowedError') {
        console.warn('[Video] Autoplay blocked, waiting for user interaction');
        document.addEventListener(
          'click',
          () => element.play().catch(e => console.error('[Video] Retry play error:', e)),
          { once: true }
        );
      }
    });
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
