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
import api from '../../services/api.service';
import { UsersService } from '../../services/users.service';

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
  isInCall = false;
  isMicMuted = false;
  isCameraEnabled = false;
  isScreenSharing = false;
  localStream?: MediaStream;
  screenStream?: MediaStream;
  peerConnections = new Map<number, RTCPeerConnection>();
  remoteStreams = new Map<
    number,
    { audio?: MediaStream; camera?: MediaStream; screen?: MediaStream }
  >();
  private negotiating = new Map<number, boolean>();
  private iceCandidatesQueue = new Map<number, RTCIceCandidate[]>();
  users: { id: number; name: string; picture: string }[] = [];
  voiceUserIds = new Set<number>();

  constructor(
    private authService: AuthService,
    private socketService: SocketService,
    private userService: UsersService,
    private cdr: ChangeDetectorRef
  ) {
    this.userId = this.authService.getUser().id;
  }

  async ngOnInit() {
    console.log('[Init] Initializing audio-video room component');
    this.setupSocketListeners();
    await this.socketService.joinAudioRoom(this.roomId.toString());
    await this.fetchInitialUsers();
    this.debugDomAndStreamStatePeriodically();
    this.startDiagnostics();
  }

  ngOnDestroy() {
    console.log('[Destroy] Cleaning up audio-video room component');
    this.leaveCall();
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
      this.voiceUserIds = new Set(this.users.map(u => u.id));
      this.cdr.detectChanges();
    } catch (error) {
      console.error('Failed to fetch users', error);
    }
  }

  getUserName(userId: number): string {
    const user = this.users.find(u => u.id === userId);
    return user ? user.name : `User ${userId}`;
  }

  getUserPicture(userId: number): string {
    const user = this.users.find(u => u.id === userId);
    return user ? user.picture : 'default-picture.png';
  }

  private setupSocketListeners() {
    console.log('[Socket] Setting up socket listeners');
    this.socketService.onAudioRoomMessage((message: string) => {
      console.log('[Socket] Received message:', message);
      if (message.startsWith('user_joined:')) {
        const userId = parseInt(message.split(':')[1]);
        this.voiceUserIds.add(userId);
        if (userId !== this.userId && this.isInCall) {
          console.log(`[Socket] User ${userId} joined, creating peer connection`);
          this.createPeerConnection(userId);
        }
      } else if (message.startsWith('user_left:')) {
        const userId = parseInt(message.split(':')[1]);
        this.voiceUserIds.delete(userId);
        console.log(`[Socket] User ${userId} left, closing peer connection`);
        this.closePeerConnection(userId);
      } else if (message.startsWith('stream_update:')) {
        const parts = message.split(':');
        const userId = parseInt(parts[1]);
        const state = JSON.parse(parts[2]);
        console.log(`[Socket] Stream update from user ${userId}:`, state);
        this.handleRemoteStreamUpdate(userId, state);
      } else {
        try {
          const data = JSON.parse(message);
          console.log('[Socket] Parsed signaling data:', data);
          this.handleSignalingData(data);
        } catch (error) {
          console.error('[Socket] Failed to parse message:', message, error);
        }
      }
      this.cdr.detectChanges();
    });
  }

  private safePlayVideo(element: HTMLVideoElement) {
    try {
      const playPromise = element.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => console.log('[Video] Playback started for', element))
          .catch(err => console.error('[Video] Play error:', err));
      }
    } catch (err) {
      console.error('[Video] Play exception:', err);
    }
  }

  private async createPeerConnection(userId: number) {
    if (this.peerConnections.has(userId)) {
      console.log(`[PeerConnection] Connection already exists for user: ${userId}`);
      return;
    }

    console.log(`[PeerConnection] Creating new connection for user: ${userId}`);
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        {
          urls: 'turn:standard.relay.metered.ca:80',
          username: '0e20581fb4b8fc2be07831e3',
          credential: '1KJmXjnD4HKrE2uk',
        },
        {
          urls: 'turn:standard.relay.metered.ca:443',
          username: '0e20581fb4b8fc2be07831e3',
          credential: '1KJmXjnD4HKrE2uk',
        },
      ],
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-compat',
      rtcpMuxPolicy: 'require'
    });

    this.peerConnections.set(userId, pc);
    this.iceCandidatesQueue.set(userId, []);
    this.addLocalTracks(pc);
    this.monitorConnectionQuality(userId);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log(`[ICE] Sending ICE candidate to user ${userId}:`, event.candidate);
        this.socketService.sendMessage(
          JSON.stringify({
            type: 'ice-candidate',
            sender: this.userId,
            target: userId,
            candidate: event.candidate
          }),
          true,
          'audioRoom'
        );
      } else {
        console.log(`[ICE] ICE gathering complete for user ${userId}`);
      }
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0];
      const track = event.track;
      console.log(`[PeerConnection] Received track from user ${userId}: kind=${track.kind}, enabled=${track.enabled}, streamId=${stream.id}, tracks=${stream.getTracks().map(t => t.id).join(', ')}`);
      this.handleRemoteTrack(userId, stream, track);
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[ICE] Connection state changed for user ${userId}: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'connected') {
        console.log(`[ICE] Fully connected to user ${userId}`);
        this.verifyAllStreams(userId);
      } else if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        console.warn(`[ICE] Connection ${pc.iceConnectionState} for user ${userId}, attempting ICE restart`);
        this.createOffer(userId);
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[Connection] State for user ${userId}: ${pc.connectionState}`);
      if (pc.connectionState === 'failed') {
        console.warn(`[Connection] Failed for user ${userId}, restarting`);
        this.closePeerConnection(userId);
        this.createPeerConnection(userId);
      }
    };

    pc.onsignalingstatechange = () => {
      console.log(`[Signaling] State for user ${userId}: ${pc.signalingState}`);
    };

    pc.onnegotiationneeded = () => {
      console.log(`[PeerConnection] Negotiation needed for user ${userId}`);
      if (!this.negotiating.get(userId)) {
        this.createOffer(userId);
      }
    };

    try {
      console.log(`[PeerConnection] Initializing connection for user ${userId}`);
    } catch (error) {
      console.error(`[PeerConnection] Initialization error for user ${userId}:`, error);
    }
  }

  private verifyAllStreams(userId: number) {
    console.log(`[Verify] Verifying all streams for user ${userId}`);
    const streams = this.remoteStreams.get(userId);
    if (!streams) return;

    if (streams.camera) {
      this.verifyStreamPlayback(userId, 'camera', streams.camera);
    }
    if (streams.screen) {
      this.verifyStreamPlayback(userId, 'screen', streams.screen);
    }

    setTimeout(() => {
      if (this.remoteStreams.get(userId)?.camera) {
        this.verifyStreamPlayback(userId, 'camera', this.remoteStreams.get(userId)!.camera!);
      }
      if (this.remoteStreams.get(userId)?.screen) {
        this.verifyStreamPlayback(userId, 'screen', this.remoteStreams.get(userId)!.screen!);
      }
    }, 2000);
  }

  private verifyStreamPlayback(userId: number, type: 'camera' | 'screen', stream: MediaStream) {
    const videoElement = this.remoteContainerRef.nativeElement.querySelector(
      `video[data-user-id="${userId}"][data-type="${type}"]`
    ) as HTMLVideoElement;

    if (!videoElement) {
      console.error(`[Verify] Video element not found for user ${userId}, type ${type}`);
      return;
    }

    console.log(`[Verify] Stream state for user ${userId}, type ${type}:`, {
      active: stream.active,
      tracks: stream.getTracks().map(t => ({
        id: t.id,
        kind: t.kind,
        readyState: t.readyState,
        enabled: t.enabled
      }))
    });

    if (stream.active && stream.getTracks().length > 0) {
      if (videoElement.srcObject !== stream) {
        console.log(`[Verify] Reattaching stream for user ${userId}, type ${type}`);
        videoElement.srcObject = stream;
      }
      this.safePlayVideo(videoElement);
    }
  }

  private addLocalTracks(pc: RTCPeerConnection) {
    if (this.localStream?.getAudioTracks().length) {
      const audioTrack = this.localStream.getAudioTracks()[0];
      if (!this.isTrackAlreadyAdded(pc, audioTrack)) {
        console.log('[PeerConnection] Adding local audio track');
        pc.addTrack(audioTrack, this.localStream);
      }
    }
    if (this.localStream?.getVideoTracks().length && this.isCameraEnabled) {
      const videoTrack = this.localStream.getVideoTracks()[0];
      if (!this.isTrackAlreadyAdded(pc, videoTrack)) {
        console.log('[PeerConnection] Adding local camera track');
        pc.addTrack(videoTrack, this.localStream);
      }
    }
    if (this.screenStream?.getVideoTracks().length && this.isScreenSharing) {
      const screenTrack = this.screenStream.getVideoTracks()[0];
      if (!this.isTrackAlreadyAdded(pc, screenTrack)) {
        console.log('[PeerConnection] Adding local screen track');
        pc.addTrack(screenTrack, this.screenStream);
      }
    }
  }

  private isTrackAlreadyAdded(pc: RTCPeerConnection, track: MediaStreamTrack): boolean {
    return pc.getSenders().some(sender => sender.track === track);
  }

  private getLocalStreamState() {
    return {
      audio: (this.localStream?.getAudioTracks().length ?? 0) > 0 && !this.isMicMuted,
      camera: (this.localStream?.getVideoTracks().length ?? 0) > 0 && this.isCameraEnabled,
      screen: this.isScreenSharing && (this.screenStream?.getVideoTracks().length ?? 0) > 0
    };
  }

  private updateStreamStateForAll() {
    const state = this.getLocalStreamState();
    this.peerConnections.forEach((_, userId) => {
      console.log(`[Socket] Sending stream-update to user ${userId}:`, state);
      this.socketService.sendMessage(
        `stream_update:${userId}:${JSON.stringify(state)}`,
        false,
        'audioRoom'
      );
    });
  }

  async joinCall() {
    if (this.isInCall) {
      console.log('[Call] Already in call, ignoring join request');
      return;
    }

    console.log('[Call] Joining voice room');
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: this.isCameraEnabled
      });
      console.log('[Media] Got local media stream with tracks:', this.localStream.getTracks().map(t => `${t.kind} (${t.id})`));
      if (this.localVideoRef?.nativeElement) {
        this.localVideoRef.nativeElement.srcObject = this.localStream;
        this.localVideoRef.nativeElement.muted = true;
        this.safePlayVideo(this.localVideoRef.nativeElement);
      }
      this.isInCall = true;
      console.log(`[Socket] User ${this.userId} joining room ${this.roomId}`);
      this.socketService.sendMessage(`user_joined:${this.userId}`, false, 'audioRoom');
      this.updateStreamStateForAll();
      this.voiceUserIds.forEach(userId => {
        if (userId !== this.userId) {
          this.createPeerConnection(userId);
        }
      });
    } catch (error) {
      console.error('[Call] Error joining call:', error);
      alert('Could not access microphone/camera');
    }
  }

  leaveCall() {
    console.log('[Call] Leaving voice call');
    this.peerConnections.forEach((pc, userId) => {
      this.closePeerConnection(userId);
    });
    if (this.localStream) {
      console.log('[Media] Stopping local stream tracks');
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = undefined;
    }
    if (this.screenStream) {
      console.log('[Media] Stopping screen share tracks');
      this.screenStream.getTracks().forEach(track => track.stop());
      this.screenStream = undefined;
    }
    this.isInCall = false;
    this.isScreenSharing = false;
    this.isCameraEnabled = false;
    this.isMicMuted = false;
    if (this.localVideoRef?.nativeElement) {
      this.localVideoRef.nativeElement.srcObject = null;
    }
    console.log(`[Socket] User ${this.userId} leaving room ${this.roomId}`);
    this.socketService.sendMessage(`user_left:${this.userId}`, false, 'audioRoom');
  }

  toggleMic() {
    console.log('[Mic] Toggling mic mute', this.isMicMuted);
    if (!this.isInCall || !this.localStream) return;
    this.isMicMuted = !this.isMicMuted;
    this.localStream.getAudioTracks().forEach(track => {
      track.enabled = !this.isMicMuted;
      console.log(`[Mic] ${track.enabled ? 'Unmuted' : 'Muted'} audio track:`, track.id);
    });
    this.updateStreamStateForAll();
  }

  async toggleCamera() {
    console.log('[Camera] Toggling camera, current state:', this.isCameraEnabled);
    if (!this.isInCall) {
      console.warn('[Camera] Not in call, cannot toggle camera');
      return;
    }

    try {
      if (!this.isCameraEnabled) {
        console.log('[Camera] Enabling camera');
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        const newVideoTrack = stream.getVideoTracks()[0];

        if (!this.localStream) {
          this.localStream = new MediaStream();
          if (this.isInCall) {
            const audioStream = await navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
              }
            });
            audioStream.getAudioTracks().forEach(track => this.localStream!.addTrack(track));
          }
        }

        this.localStream.getVideoTracks().forEach(track => {
          track.stop();
          this.localStream!.removeTrack(track);
        });

        this.localStream.addTrack(newVideoTrack);
        console.log('[Camera] Added video track to local stream:', newVideoTrack.id);

        if (this.localVideoRef?.nativeElement) {
          this.localVideoRef.nativeElement.srcObject = this.localStream;
          this.localVideoRef.nativeElement.onloadeddata = () => {
            this.safePlayVideo(this.localVideoRef.nativeElement);
          };
        }

        this.peerConnections.forEach((pc, userId) => {
          const videoSender = this.getVideoSenderForConnection(pc, false);
          if (videoSender) {
            console.log(`[Camera] Replacing camera track for user ${userId}`);
            videoSender.replaceTrack(newVideoTrack);
          } else if (!this.isTrackAlreadyAdded(pc, newVideoTrack)) {
            console.log(`[Camera] Adding camera track to peer connection for user ${userId}`);
            pc.addTrack(newVideoTrack, this.localStream!);
          }
          this.createOffer(userId);
        });

        this.isCameraEnabled = true;
      } else {
        console.log('[Camera] Disabling camera');
        const videoTrack = this.localStream?.getVideoTracks()[0];
        if (videoTrack) {
          console.log('[Camera] Stopping video track:', videoTrack.id);
          videoTrack.stop();
          this.localStream?.removeTrack(videoTrack);

          if (this.localVideoRef?.nativeElement) {
            this.localVideoRef.nativeElement.srcObject = this.localStream?.getTracks().length ? this.localStream : null;
          }

          this.peerConnections.forEach((pc, userId) => {
            const videoSender = this.getVideoSenderForConnection(pc, false);
            if (videoSender) {
              console.log(`[Camera] Replacing camera track with null for user ${userId}`);
              videoSender.replaceTrack(null);
            }
            this.createOffer(userId);
          });
        }
        this.isCameraEnabled = false;
      }

      this.updateStreamStateForAll();
      this.cdr.detectChanges();
    } catch (err) {
      console.error('[Camera] Error toggling camera:', err);
      this.isCameraEnabled = !this.isCameraEnabled;
      this.updateStreamStateForAll();
    }
  }

  async toggleScreenShare() {
    console.log('[ScreenShare] Toggling screen share, current state:', this.isScreenSharing);
    if (!this.isInCall) {
      console.warn('[ScreenShare] Not in call, cannot toggle screen share');
      return;
    }

    try {
      if (!this.isScreenSharing) {
        console.log('[ScreenShare] Starting screen share');
        this.screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 15 }
        });
        const videoTrack = this.screenStream.getVideoTracks()[0];
        videoTrack.contentHint = 'detail';
        videoTrack.onended = () => {
          console.log('[ScreenShare] Screen share track ended');
          this.toggleScreenShare();
        };
        this.isScreenSharing = true;

        this.peerConnections.forEach((pc, userId) => {
          if (this.screenStream?.getVideoTracks().length) {
            const screenTrack = this.screenStream.getVideoTracks()[0];
            const screenSender = this.getVideoSenderForConnection(pc, true);
            if (screenSender) {
              console.log(`[ScreenShare] Replacing screen track for user ${userId}`);
              screenSender.replaceTrack(screenTrack);
            } else {
              console.log(`[ScreenShare] Adding screen track for user ${userId}`);
              pc.addTrack(screenTrack, this.screenStream);
            }
            this.createOffer(userId);
          }
        });

      } else {
        console.log('[ScreenShare] Stopping screen share');
        if (this.screenStream) {
          this.screenStream.getTracks().forEach(track => track.stop());
          this.screenStream = undefined;
        }
        this.isScreenSharing = false;

        this.peerConnections.forEach((pc, userId) => {
          const screenSender = this.getVideoSenderForConnection(pc, true);
          if (screenSender) {
            console.log(`[ScreenShare] Replacing screen track with null for user ${userId}`);
            screenSender.replaceTrack(null);
          }
          this.createOffer(userId);
        });
      }

      this.updateStreamStateForAll();
      this.cdr.detectChanges();
    } catch (err) {
      console.error('[ScreenShare] Error toggling screen share:', err);
      this.isScreenSharing = false;
      this.updateStreamStateForAll();
    }
  }

  private getVideoSenderForConnection(pc: RTCPeerConnection, isScreen: boolean): RTCRtpSender | null {
    return pc.getSenders().find(sender => {
      if (!sender.track || sender.track.kind !== 'video') return false;
      if (isScreen) {
        return sender.track.contentHint === 'detail' || sender.track.id.includes('screen');
      } else {
        return sender.track.contentHint !== 'detail' && !sender.track.id.includes('screen');
      }
    }) || null;
  }

  private debugStreamState() {
    console.log('[Debug] Current remote streams state:');
    this.remoteStreams.forEach((streams, userId) => {
      console.log(`User ${userId}:`, {
        audio: streams.audio
          ? `active (tracks: ${streams.audio.getTracks().length}, ids: [${streams.audio.getTracks().map(t => t.id).join(', ')}])`
          : 'inactive',
        camera: streams.camera
          ? `active (tracks: ${streams.camera.getTracks().length}, ids: [${streams.camera.getTracks().map(t => t.id).join(', ')}])`
          : 'inactive',
        screen: streams.screen
          ? `active (tracks: ${streams.screen.getTracks().length}, ids: [${streams.screen.getTracks().map(t => t.id).join(', ')}])`
          : 'inactive'
      });
    });
  }

  private debugDomAndStreamStatePeriodically() {
    setInterval(() => {
      console.log('[Debug] Periodic DOM and Stream State Check');
      this.debugStreamState();
      this.debugDomState();
    }, 5000);
  }

  private debugDomState() {
    const remoteContainer = this.remoteContainerRef?.nativeElement;
    const audioContainer = this.audioContainerRef?.nativeElement;

    console.log('[Debug] Remote Container DOM State:', {
      exists: !!remoteContainer,
      isVisible: remoteContainer ? remoteContainer.offsetParent !== null : false,
      computedDisplay: remoteContainer ? window.getComputedStyle(remoteContainer).display : 'N/A',
      childCount: remoteContainer ? remoteContainer.children.length : 0,
      videoElements: remoteContainer
        ? Array.from(remoteContainer.querySelectorAll('video')).map(v => ({
            id: v.id,
            userId: v.getAttribute('data-user-id'),
            type: v.getAttribute('data-type'),
            hasSrcObject: !!v.srcObject,
            isVisible: v.offsetParent !== null,
            computedDisplay: window.getComputedStyle(v).display,
            dimensions: { width: v.offsetWidth, height: v.offsetHeight },
            tracks: v.srcObject instanceof MediaStream
              ? v.srcObject.getTracks().map(t => ({
                  kind: t.kind,
                  id: t.id,
                  enabled: t.enabled,
                  readyState: t.readyState
                }))
              : []
          }))
        : []
    });

    console.log('[Debug] Audio Container DOM State:', {
      exists: !!audioContainer,
      isVisible: audioContainer ? audioContainer.offsetParent !== null : false,
      computedDisplay: audioContainer ? window.getComputedStyle(audioContainer).display : 'N/A',
      childCount: audioContainer ? audioContainer.children.length : 0,
      audioElements: audioContainer
        ? Array.from(audioContainer.querySelectorAll('audio')).map(a => ({
            userId: a.getAttribute('data-user-id'),
            hasSrcObject: !!a.srcObject,
            tracks: a.srcObject instanceof MediaStream
              ? a.srcObject.getTracks().map(t => ({
                  kind: t.kind,
                  id: t.id,
                  enabled: t.enabled,
                  readyState: t.readyState
                }))
              : []
          }))
        : []
    });
  }

  private createRemoteAudioElement(userId: number, stream: MediaStream | null) {
    const container = this.audioContainerRef?.nativeElement;
    if (!container) {
      console.error('[Audio] Audio container not found - Check audioContainerRef binding');
      return;
    }

    let audioElement = container.querySelector(`audio[data-user-id="${userId}"]`) as HTMLAudioElement;
    if (!audioElement) {
      console.log(`[Audio] Creating new audio element for user ${userId}`);
      audioElement = document.createElement('audio');
      audioElement.setAttribute('data-user-id', userId.toString());
      audioElement.autoplay = true;
      audioElement.style.display = 'none';
      container.appendChild(audioElement);
    } else {
      console.log(`[Audio] Updating existing audio element for user ${userId}`);
      audioElement.srcObject = null;
    }

    if (stream && stream.getTracks().length > 0 && stream.getTracks().some(t => t.readyState === 'live')) {
      console.log(`[Audio] Assigning stream with tracks to user ${userId}:`, stream.getTracks().map(t => ({
        kind: t.kind,
        id: t.id,
        enabled: t.enabled,
        readyState: t.readyState
      })));
      audioElement.srcObject = stream;

      stream.getAudioTracks().forEach(track => {
        track.onmute = () => console.log(`[Audio] Track muted for user ${userId}, trackId: ${track.id}, readyState: ${track.readyState}`);
        track.onunmute = () => {
          console.log(`[Audio] Track unmuted for user ${userId}, trackId: ${track.id}`);
          audioElement.play().catch(err => console.error(`[Audio] Unmute play error for user ${userId}:`, err));
        };
        track.onended = () => {
          console.log(`[Audio] Track ended for user ${userId}, trackId: ${track.id}`);
          audioElement.srcObject = null;
        };
      });

      audioElement.play().catch(err => {
        console.error(`[Audio] Error playing audio for user ${userId}:`, err);
        if (err.name === 'NotAllowedError') {
          console.warn('[Audio] Autoplay blocked, waiting for user interaction');
          document.addEventListener(
            'click',
            () => audioElement.play().catch(e => console.error('[Audio] Retry play error:', e)),
            { once: true }
          );
        }
      });
    } else {
      console.warn(`[Audio] Invalid or empty stream for user ${userId}`, {
        streamExists: !!stream,
        trackCount: stream?.getTracks().length || 0,
        trackStates: stream?.getTracks().map(t => t.readyState) || []
      });
      audioElement.srcObject = null;
    }

    console.log(`[Audio] Audio element state for user ${userId}:`, {
      exists: !!audioElement,
      isAttached: !!audioElement.parentElement,
      hasSrcObject: !!audioElement.srcObject,
      computedDisplay: window.getComputedStyle(audioElement).display
    });

    this.cdr.detectChanges();
  }

  private handleRemoteTrack(userId: number, stream: MediaStream, track: MediaStreamTrack) {
    console.log(`[Track] Received ${track.kind} track from user ${userId}`, {
      trackId: track.id,
      enabled: track.enabled,
      readyState: track.readyState,
      streamId: stream.id
    });

    if (track.readyState !== 'live') {
      console.warn(`[Track] Ignoring non-live track for user ${userId}`);
      return;
    }

    let remoteStreams = this.remoteStreams.get(userId) || {};
    const isScreen = track.kind === 'video' &&
                    (track.contentHint === 'detail' || track.id.includes('screen'));
    const newStream = new MediaStream([track]);

    if (track.kind === 'audio') {
      if (remoteStreams.audio && remoteStreams.audio !== newStream) {
        remoteStreams.audio.getTracks().forEach(t => t.stop());
      }
      remoteStreams.audio = newStream;
      this.createRemoteAudioElement(userId, newStream);
    } else if (track.kind === 'video') {
      if (isScreen) {
        if (remoteStreams.screen && remoteStreams.screen !== newStream) {
          remoteStreams.screen.getTracks().forEach(t => t.stop());
        }
        remoteStreams.screen = newStream;
      } else {
        if (remoteStreams.camera && remoteStreams.camera !== newStream) {
          remoteStreams.camera.getTracks().forEach(t => t.stop());
        }
        remoteStreams.camera = newStream;
      }

      const type = isScreen ? 'screen' : 'camera';
      const videoElement = this.remoteContainerRef.nativeElement.querySelector(
        `video[data-user-id="${userId}"][data-type="${type}"]`
      ) as HTMLVideoElement;
      if (videoElement) {
        videoElement.srcObject = newStream;
        this.safePlayVideo(videoElement);
      }
    }

    this.remoteStreams.set(userId, remoteStreams);
    this.cdr.detectChanges();
  }

  private monitorConnectionQuality(userId: number) {
    const pc = this.peerConnections.get(userId);
    if (!pc) return;

    const statsInterval = setInterval(async () => {
      if (pc.connectionState === 'closed') {
        clearInterval(statsInterval);
        return;
      }

      try {
        const stats = await pc.getStats();
        stats.forEach(report => {
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            console.log(`[Stats] Video stats for user ${userId}:`, {
              framesDecoded: report.framesDecoded,
              framesDropped: report.framesDropped,
              frameWidth: report.frameWidth,
              frameHeight: report.frameHeight,
              bitrate: report.bitrate
            });
          }
        });
      } catch (err) {
        console.error(`[Stats] Error getting stats for user ${userId}:`, err);
      }
    }, 5000);

    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'closed') {
        clearInterval(statsInterval);
      }
    });
  }

  private logTransceivers(userId: number) {
    const pc = this.peerConnections.get(userId);
    if (!pc) return;

    console.log(`[Transceivers] for user ${userId}:`,
      pc.getTransceivers().map(t => ({
        mid: t.mid,
        senderTrack: t.sender.track?.id,
        receiverTrack: t.receiver.track?.id,
        direction: t.direction,
        currentDirection: t.currentDirection
      }))
    );
  }

  private verifyIceConnection(userId: number) {
    const pc = this.peerConnections.get(userId);
    if (!pc) return;

    console.log(`[ICE] Connection state for user ${userId}:`, {
      iceConnectionState: pc.iceConnectionState,
      iceGatheringState: pc.iceGatheringState,
      connectionState: pc.connectionState
    });
  }

  private verifyVideoElementPlayback(userId: number, type: 'camera' | 'screen') {
    const videoElement = this.remoteContainerRef.nativeElement.querySelector(
      `video[data-user-id="${userId}"][data-type="${type}"]`
    ) as HTMLVideoElement;

    if (!videoElement) {
      console.error(`[Verify] Video element not found for user ${userId}, type ${type}`);
      return;
    }

    console.log(`[Verify] Playback state for user ${userId}, type ${type}:`, {
      paused: videoElement.paused,
      readyState: videoElement.readyState,
      networkState: videoElement.networkState,
      error: videoElement.error,
      currentTime: videoElement.currentTime,
      videoDimensions: `${videoElement.videoWidth}x${videoElement.videoHeight}`,
      streamState: videoElement.srcObject ? {
        active: (videoElement.srcObject as MediaStream).active,
        tracks: (videoElement.srcObject as MediaStream).getTracks().map(t => ({
          id: t.id,
          kind: t.kind,
          readyState: t.readyState,
          enabled: t.enabled
        }))
      } : null
    });

    if (videoElement.paused || videoElement.readyState < 2) {
      console.warn(`[Verify] Video is paused or not ready - attempting to play`);
      this.safePlayVideo(videoElement);
    }
  }

  private debugAllVideoElements() {
    this.remoteStreams.forEach((_, userId) => {
      this.verifyVideoElementPlayback(userId, 'camera');
      this.verifyVideoElementPlayback(userId, 'screen');
    });
  }

  private handleSignalingData(data: any) {
    const userId = data.sender || data.target;
    if (userId === this.userId) {
      console.log('[Signaling] Ignoring self signaling data:', userId);
      return;
    }
    if (!userId) {
      console.error('[Signaling] Invalid signaling data - missing user ID:', data);
      return;
    }
    console.log(`[Signaling] Received ${data.type} from user ${userId}:`, data);
    switch (data.type) {
      case 'offer': this.handleOffer(userId, data); break;
      case 'answer': this.handleAnswer(userId, data); break;
      case 'ice-candidate': this.handleCandidate(userId, data.candidate); break;
      case 'stream-update': this.handleRemoteStreamUpdate(userId, data.state); break;
      default: console.warn('[Signaling] Unknown signaling message type:', data.type);
    }
  }

  private async handleOffer(userId: number, offer: any) {
    let pc = this.peerConnections.get(userId);
    if (!pc) {
      console.log(`[Offer] No existing PC, creating one for user ${userId}`);
      this.createPeerConnection(userId);
      pc = this.peerConnections.get(userId)!;
    }
    try {
      console.log(`[Offer] Setting remote offer from user ${userId}:`, offer.sdp.substring(0, 100) + '...');
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      console.log(`[Answer] Created answer for user ${userId}:`, answer.sdp!.substring(0, 100) + '...');
      await pc.setLocalDescription(answer);
      console.log(`[Offer] Sending answer to user ${userId}`);
      this.socketService.sendMessage(
        JSON.stringify({
          type: 'answer',
          sender: this.userId,
          target: userId,
          sdp: answer.sdp
        }),
        true,
        'audioRoom'
      );
      const pendingCandidates = this.iceCandidatesQueue.get(userId) || [];
      for (const candidate of pendingCandidates) {
        await pc.addIceCandidate(candidate);
        console.log(`[Offer] Added pending ICE candidate for user ${userId}`);
      }
      this.iceCandidatesQueue.delete(userId);
    } catch (error) {
      console.error('[Offer] Error handling offer:', error);
      this.closePeerConnection(userId);
      this.createPeerConnection(userId);
    }
  }

  private async handleCandidate(userId: number, candidate: any) {
    const pc = this.peerConnections.get(userId);
    if (!pc) {
      console.log(`[ICE] Queueing candidate for user ${userId} (no PC yet)`);
      const queue = this.iceCandidatesQueue.get(userId) || [];
      queue.push(new RTCIceCandidate(candidate));
      this.iceCandidatesQueue.set(userId, queue);
      return;
    }
    try {
      if (pc.remoteDescription && pc.remoteDescription.type) {
        console.log(`[ICE] Adding ICE candidate from user ${userId}:`, candidate);
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } else {
        console.log(`[ICE] Queueing candidate for user ${userId} (no remote desc)`);
        const queue = this.iceCandidatesQueue.get(userId) || [];
        queue.push(new RTCIceCandidate(candidate));
        this.iceCandidatesQueue.set(userId, queue);
      }
    } catch (error) {
      console.error('[ICE] Error adding candidate:', error);
    }
  }

  private async handleAnswer(userId: number, answer: any) {
    const pc = this.peerConnections.get(userId);
    if (!pc || pc.signalingState !== 'have-local-offer') {
      console.log(`[Answer] Ignoring answer from user ${userId} - invalid state: ${pc?.signalingState || 'no connection'}`);
      return;
    }
    try {
      console.log(`[Answer] Setting remote answer from user ${userId}:`, answer.sdp.substring(0, 100) + '...');
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      console.log(`[Answer] Answer set, state: ${pc.signalingState}`);
      if (this.iceCandidatesQueue.has(userId)) {
        console.log(`[Answer] Processing ${this.iceCandidatesQueue.get(userId)!.length} pending candidates for user ${userId}`);
        for (const candidate of this.iceCandidatesQueue.get(userId)!) {
          await pc.addIceCandidate(candidate);
          console.log(`[Answer] Added pending ICE candidate for user ${userId}`);
        }
        this.iceCandidatesQueue.delete(userId);
      }
    } catch (error) {
      console.error('[Answer] Answer handling error:', error);
      this.closePeerConnection(userId);
      this.createPeerConnection(userId);
    }
  }

  private handleRemoteStreamUpdate(userId: number, state: any) {
    const streams = this.remoteStreams.get(userId) || {};
    if (!state.audio && streams.audio) {
      streams.audio.getTracks().forEach(track => track.stop());
      streams.audio = undefined;
      console.log(`[StreamUpdate] Stopped audio stream for user ${userId}`);
      this.createRemoteAudioElement(userId, null);
    }
    if (!state.camera && streams.camera) {
      streams.camera.getTracks().forEach(track => track.stop());
      streams.camera = undefined;
      console.log(`[StreamUpdate] Stopped camera stream for user ${userId}`);
    }
    if (!state.screen && streams.screen) {
      streams.screen.getTracks().forEach(track => track.stop());
      streams.screen = undefined;
      console.log(`[StreamUpdate] Stopped screen stream for user ${userId}`);
    }
    this.remoteStreams.set(userId, streams);
    this.debugStreamState();
    this.cdr.detectChanges();
  }

  private closePeerConnection(userId: number) {
    const pc = this.peerConnections.get(userId);
    if (pc) {
      pc.close();
      this.peerConnections.delete(userId);
      this.negotiating.delete(userId);
      this.iceCandidatesQueue.delete(userId);
      this.removeRemoteElements(userId);
      this.remoteStreams.delete(userId);
      console.log(`[PeerConnection] Closed peer connection for user ${userId}`);
      this.cdr.detectChanges();
    }
  }

  private removeRemoteElements(userId: number) {
    const audioElement = this.audioContainerRef.nativeElement.querySelector(
      `audio[data-user-id="${userId}"]`
    );
    if (audioElement) {
      audioElement.remove();
      console.log(`[Audio] Removed audio element for user ${userId}`);
    }
    const videoElements = this.remoteContainerRef.nativeElement.querySelectorAll(
      `video[data-user-id="${userId}"]`
    );
    videoElements.forEach(element => element.remove());
    console.log(`[Video] Removed video elements for user ${userId}`);
  }

  private startDiagnostics() {
    setInterval(() => {
      this.debugAllVideoElements();
      this.peerConnections.forEach((_, userId) => {
        this.logTransceivers(userId);
        this.verifyIceConnection(userId);
      });
    }, 5000);
  }

  private async createOffer(userId: number) {
    if (this.negotiating.get(userId)) {
      console.log(`[PeerConnection] Negotiation in progress for user ${userId}, skipping`);
      return;
    }
    this.negotiating.set(userId, true);
    const pc = this.peerConnections.get(userId);
    if (!pc) {
      console.warn(`[PeerConnection] No peer connection for user ${userId}`);
      this.negotiating.set(userId, false);
      return;
    }
    try {
      console.log(`[PeerConnection] Creating offer for user ${userId}, state: ${pc.signalingState}, iceGatheringState: ${pc.iceGatheringState}`);
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
        iceRestart: pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected'
      });
      await pc.setLocalDescription(offer);
      console.log(`[PeerConnection] Offer created and set:`, offer.sdp!.substring(0, 100) + '...');
      this.socketService.sendMessage(
        JSON.stringify({
          type: 'offer',
          sender: this.userId,
          target: userId,
          sdp: offer.sdp,
          streams: this.getLocalStreamState()
        }),
        true,
        'audioRoom'
      );
    } catch (error) {
      console.error('[PeerConnection] Create offer error:', error);
    } finally {
      this.negotiating.set(userId, false);
    }
  }
}
