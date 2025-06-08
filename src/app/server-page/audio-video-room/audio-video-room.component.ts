import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { AuthService } from '../../services/auth.service';
import { SocketService } from '../../services/socket.service';
import { UsersService } from '../../services/users.service';
import { HttpClient } from '@angular/common/http';

@Component({
  selector: 'app-audio-video-room',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './audio-video-room.component.html',
  styleUrls: ['./audio-video-room.component.scss']
})
export class AudioVideoRoomComponent implements OnInit, OnDestroy {
  @ViewChild('localVideo') localVideoRef!: ElementRef<HTMLVideoElement>;
  @ViewChild('remoteContainer') remoteContainerRef!: ElementRef<HTMLDivElement>;
  @ViewChild('audioContainer') audioContainerRef!: ElementRef<HTMLDivElement>;

  roomId = 14;
  userId: number;
  users: any[] = [];
  localStream?: MediaStream;
  peerConnections = new Map<number, { pc: RTCPeerConnection, displayName: string }>();
  voiceUserIds = new Set<number>();
  private changeDetectionTimeout: any;

  isMuted = false;
  isScreenSharing = false;
  private screenStream?: MediaStream;
  private peerStreams = new Map<number, MediaStream>();

  private peerConnectionConfig = {
    iceServers: [
      { urls: 'stun:stun.stunprotocol.org:3478' },
      { urls: 'stun:stun.l.google.com:19302' }
    ]
  };

  constructor(
    public authService: AuthService,
    private socketService: SocketService,
    private userService: UsersService,
    private http: HttpClient,
    private cdr: ChangeDetectorRef
  ) {
    this.userId = this.authService.getUser().id;
  }

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

    // Clean up event listeners
    this.localStream?.getTracks().forEach(track => {
      track.removeEventListener('ended', this.handleLocalTrackEnded);
    });
  }

  private async fetchInitialUsers() {
    try {
      const res = await this.http.get(`http://lamzaone.go.ro:8000/api/room/${this.roomId}/users`).toPromise() as any;
      this.users = await Promise.all(
        res.userIds.map(async (id: string) => {
          const user = await this.userService.getUserInfo(id);
          return { ...user, id: parseInt(id) };
        })
      );
      this.voiceUserIds = new Set(this.users.map(u => u.id));
      this.debounceChangeDetection();
    } catch (error) {
      console.error('[Init] Failed to fetch users', error);
    }
  }

  private setupSocketListeners() {
    console.log('[Socket] Setting up socket listeners');
    this.socketService.onAudioRoomMessage((message: string) => {
      try {
        const signal = JSON.parse(message);
        const peerId = signal.userId;

        if (peerId === this.userId || (!signal.dest && signal.dest !== this.userId && signal.dest !== 'all')) {
          return;
        }

        if (signal.displayName && signal.dest === 'all') {
          this.setUpPeer(peerId, signal.displayName);
          this.socketService.sendMessage(
            JSON.stringify({
              displayName: this.authService.getUser().name,
              userId: this.userId,
              dest: peerId
            }),
            true,
            'audioRoom'
          );
        } else if (signal.displayName && signal.dest === this.userId) {
          this.setUpPeer(peerId, signal.displayName, true);
        } else if (signal.sdp) {
          const pc = this.peerConnections.get(peerId)?.pc;
          if (pc) {
            pc.setRemoteDescription(new RTCSessionDescription(signal.sdp))
              .then(() => {
                if (signal.sdp.type === 'offer') {
                  pc.createAnswer()
                    .then(description => this.createdDescription(description, peerId))
                    .catch(this.errorHandler);
                }
              })
              .catch(this.errorHandler);
          }
        } else if (signal.ice) {
          const pc = this.peerConnections.get(peerId)?.pc;
          if (pc) {
            pc.addIceCandidate(new RTCIceCandidate(signal.ice)).catch(this.errorHandler);
          }
        }
      } catch (error) {
        console.warn('[Socket] Error parsing message:', error);
      }
      this.debounceChangeDetection();
    });
  }

  async joinCall() {
    console.log('[Call] Joining voice room');
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { max: 320 },
          height: { max: 240 },
          frameRate: { max: 30 }
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      // Add ended listeners for local tracks
      this.localStream.getTracks().forEach(track => {
        track.addEventListener('ended', this.handleLocalTrackEnded);
      });

      if (this.localVideoRef?.nativeElement) {
        this.localVideoRef.nativeElement.srcObject = this.localStream;
        this.localVideoRef.nativeElement.muted = true;
        this.safePlayVideo(this.localVideoRef.nativeElement);
      }

      this.socketService.sendMessage(
        JSON.stringify({
          displayName: this.authService.getUser().name,
          userId: this.userId,
          dest: 'all'
        }),
        true,
        'audioRoom'
      );

      this.debounceChangeDetection();
    } catch (error) {
      console.error('[Call] Error joining call:', error);
      alert('Could not access microphone/camera');
    }
  }

  leaveCall() {
    console.log('[Call] Leaving voice call');
    this.peerConnections.forEach((_, peerId) => this.closePeerConnection(peerId));
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        track.stop();
        track.removeEventListener('ended', this.handleLocalTrackEnded);
      });
      this.localStream = undefined;
    }
    if (this.localVideoRef?.nativeElement) {
      this.localVideoRef.nativeElement.srcObject = null;
    }
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(track => track.stop());
      this.screenStream = undefined;
    }
    this.voiceUserIds.clear();
    this.socketService.sendMessage(`user_left:${this.userId}`, false, 'audioRoom');
    this.isMuted = false;
    this.isScreenSharing = false;
    this.debounceChangeDetection();
  }

  // Toggle microphone mute
  toggleMute() {
    this.isMuted = !this.isMuted;
    const audioTracks = this.localStream?.getAudioTracks() || [];
    audioTracks.forEach(track => {
      track.enabled = !this.isMuted;
    });
    this.debounceChangeDetection();
  }

  // Toggle screen sharing
  async toggleScreenShare() {
    if (this.isScreenSharing) {
      await this.stopScreenShare();
    } else {
      await this.startScreenShare();
    }
  }

  private async startScreenShare() {
    if (this.isScreenSharing) return;

    try {
      // Get screen stream
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always',
          width: { max: 320 },
          height: { max: 240 },
          frameRate: { max: 30 } } as MediaTrackConstraints,
        audio: false
      });

      // Handle when user stops screen sharing
      this.screenStream.getTracks().forEach(track => {
        track.addEventListener('ended', () => this.stopScreenShare());
      });

      // Replace video track in all peer connections
      const screenTrack = this.screenStream.getVideoTracks()[0];
      this.peerConnections.forEach(({ pc }) => {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) sender.replaceTrack(screenTrack);
      });

      // Update local video element
      if (this.localStream) {
        // Create a new stream with screen track and existing audio
        const newStream = new MediaStream([
          screenTrack,
          ...this.localStream.getAudioTracks()
        ]);

        // Update local video element
        this.localVideoRef.nativeElement.srcObject = newStream;
        this.localVideoRef.nativeElement.muted = true;
        this.safePlayVideo(this.localVideoRef.nativeElement);

        // Stop old video tracks
        this.localStream.getVideoTracks().forEach(track => {
          track.stop();
          track.removeEventListener('ended', this.handleLocalTrackEnded);
        });

        // Update local stream reference
        this.localStream = newStream;
      }

      this.isScreenSharing = true;
    } catch (error) {
      console.error('[ScreenShare] Failed to start screen sharing:', error);
      if (error !== 'NotAllowedError') {
        alert('Screen sharing failed. Please try again.');
      }
    }
  }

  private async stopScreenShare() {
    if (!this.isScreenSharing) return;

    try {
      // Stop screen tracks
      this.screenStream?.getTracks().forEach(track => track.stop());
      this.screenStream = undefined;

      // Get camera stream
      const cameraStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { max: 320 },
          height: { max: 240 },
          frameRate: { max: 30 }
        },
        audio: false
      });

      const cameraTrack = cameraStream.getVideoTracks()[0];

      // Add ended listener for camera track
      cameraTrack.addEventListener('ended', this.handleLocalTrackEnded);

      // Update peer connections
      this.peerConnections.forEach(({ pc }) => {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) sender.replaceTrack(cameraTrack);
      });

      // Update local stream
      if (this.localStream) {
        // Create new stream with camera and existing audio
        const newStream = new MediaStream([
          cameraTrack,
          ...this.localStream.getAudioTracks()
        ]);

        // Update local video element
        this.localVideoRef.nativeElement.srcObject = newStream;
        this.localVideoRef.nativeElement.muted = true;
        this.safePlayVideo(this.localVideoRef.nativeElement);

        // Update local stream reference
        this.localStream = newStream;
      }

      this.isScreenSharing = false;
    } catch (error) {
      console.error('[ScreenShare] Failed to switch back to camera:', error);
      alert('Failed to switch back to camera. Please check your camera permissions.');
    }
  }

  private handleLocalTrackEnded = (event: Event) => {
    const track = event.target as MediaStreamTrack;
    console.log('[LocalTrack] Track ended:', track.kind);

    // Handle video track ended (camera or screen share)
    if (track.kind === 'video') {
      if (this.localVideoRef?.nativeElement) {
        this.localVideoRef.nativeElement.srcObject = null;
      }
    }
  }

  private setUpPeer(peerId: number, displayName: string, initCall = false) {
    console.log(`[PeerConnection] Setting up peer connection for user ${peerId}`);
    const pc = new RTCPeerConnection(this.peerConnectionConfig);
    this.peerConnections.set(peerId, { pc, displayName });

    pc.onicecandidate = event => this.gotIceCandidate(event, peerId);
    pc.ontrack = event => this.gotRemoteStream(event, peerId);
    pc.oniceconnectionstatechange = event => this.checkPeerDisconnect(event, peerId);

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream!));
    }

    if (initCall) {
      pc.createOffer()
        .then(description => this.createdDescription(description, peerId))
        .catch(this.errorHandler);
    }

    if (!this.voiceUserIds.has(peerId)) {
      this.voiceUserIds.add(peerId);
    }
  }

  private gotIceCandidate(event: RTCPeerConnectionIceEvent, peerId: number) {
    if (event.candidate) {
      console.log(`[ICE] Sending ICE candidate to user ${peerId}`);
      this.socketService.sendMessage(
        JSON.stringify({
          ice: event.candidate,
          userId: this.userId,
          dest: peerId
        }),
        true,
        'audioRoom'
      );
    }
  }

  private createdDescription(description: RTCSessionDescriptionInit, peerId: number) {
    console.log(`[PeerConnection] Created description for user ${peerId}`);
    const pc = this.peerConnections.get(peerId)?.pc;
    if (pc) {
      pc.setLocalDescription(description)
        .then(() => {
          this.socketService.sendMessage(
            JSON.stringify({
              sdp: pc.localDescription,
              userId: this.userId,
              dest: peerId
            }),
            true,
            'audioRoom'
          );
        })
        .catch(this.errorHandler);
    }
  }

  private gotRemoteStream(event: RTCTrackEvent, peerId: number) {
    console.log(`[Track] Got remote stream from user ${peerId}`);
    const stream = event.streams[0];
    this.peerStreams.set(peerId, stream);

    // Get or create container
    let container = this.remoteContainerRef?.nativeElement.querySelector(`#remoteVideo_${peerId}`);
    if (!container) {
      container = document.createElement('div');
      container.id = `remoteVideo_${peerId}`;
      container.className = 'videoContainer';
      this.remoteContainerRef?.nativeElement.appendChild(container);
    } else {
      // Clear existing content
      container.innerHTML = '';
    }

    // Add event listeners for track ended
    stream.getTracks().forEach(track => {
      track.addEventListener('ended', () => {
        this.handleRemoteTrackEnded(peerId, track.kind);
      });
    });

    // Check if video is available
    const hasVideo = stream.getVideoTracks().length > 0;
    if (hasVideo) {
      this.createVideoElement(container, stream, peerId);
    } else {
      this.createAudioIndicator(container, peerId);
    }

    this.updateLayout();
    this.debounceChangeDetection();
  }

  private createVideoElement(container: Element, stream: MediaStream, peerId: number) {
    const vidElement = document.createElement('video');
    vidElement.autoplay = true;
    vidElement.srcObject = stream;
    container.appendChild(vidElement);
    container.appendChild(this.makeLabel(this.peerConnections.get(peerId)?.displayName || ''));
    this.safePlayVideo(vidElement);
  }

  private createAudioIndicator(container: Element, peerId: number) {
    container.appendChild(this.makeAudioIndicator(peerId));
  }

  private handleRemoteTrackEnded(peerId: number, kind: string) {
    if (kind !== 'video') return;

    console.log(`[RemoteTrack] Video track ended for user ${peerId}`);
    const container = this.remoteContainerRef?.nativeElement.querySelector(`#remoteVideo_${peerId}`);
    if (!container) return;

    // Clear container and show audio indicator
    container.innerHTML = '';
    this.createAudioIndicator(container, peerId);
    this.updateLayout();
    this.debounceChangeDetection();
  }

  private checkPeerDisconnect(event: Event, peerId: number) {
    const pc = this.peerConnections.get(peerId)?.pc;
    if (!pc) return;

    const state = pc.iceConnectionState;
    console.log(`[ICE] Connection state with user ${peerId}: ${state}`);
    if (state === 'failed' || state === 'closed' || state === 'disconnected') {
      this.closePeerConnection(peerId);
      this.updateLayout();
    }
  }

  private closePeerConnection(peerId: number) {
    const peer = this.peerConnections.get(peerId);
    if (peer) {
      peer.pc.close();
      this.peerConnections.delete(peerId);
      this.voiceUserIds.delete(peerId);
      this.peerStreams.delete(peerId);

      const videoContainer = this.remoteContainerRef?.nativeElement.querySelector(`#remoteVideo_${peerId}`);
      if (videoContainer) {
        videoContainer.remove();
      }

      console.log(`[PeerConnection] Closed connection with user ${peerId}`);
      this.debounceChangeDetection();
    }
  }

  private updateLayout() {
    console.log('[Layout] Updating video layout');
    const rowHeight = '98vh';
    let colWidth = '98vw';
    const numVideos = this.peerConnections.size + 1; // +1 for local video

    if (numVideos > 1 && numVideos <= 4) {
      colWidth = '48vw';
    } else if (numVideos > 4) {
      colWidth = '32vw';
    }

    document.documentElement.style.setProperty('--rowHeight', rowHeight);
    document.documentElement.style.setProperty('--colWidth', colWidth);
  }

  private makeLabel(label: string) {
    const vidLabel = document.createElement('div');
    vidLabel.appendChild(document.createTextNode(label));
    vidLabel.setAttribute('class', 'videoLabel');
    return vidLabel;
  }

  private makeAudioIndicator(peerId: number) {
    const indicator = document.createElement('div');
    indicator.className = 'audio-indicator';
    indicator.innerHTML = `
      <div class="user-avatar">${this.getInitials(peerId)}</div>
      <div class="audio-waves">🔊</div>
      <div class="user-name">${this.peerConnections.get(peerId)?.displayName || 'User'}</div>
    `;
    return indicator;
  }

  private getInitials(peerId: number): string {
    const displayName = this.peerConnections.get(peerId)?.displayName || '';
    return displayName
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase()
      .substring(0, 2);
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

  private errorHandler(error: any) {
    console.error('[Error]', error);
  }

  private debounceChangeDetection() {
    if (this.changeDetectionTimeout) {
      clearTimeout(this.changeDetectionTimeout);
    }
    this.changeDetectionTimeout = setTimeout(() => {
      this.cdr.detectChanges();
    }, 100);
  }

  get peerConnectionKeys(): number[] {
    return Array.from(this.peerConnections.keys());
  }
}
