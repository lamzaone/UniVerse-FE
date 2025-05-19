import {
  ChangeDetectorRef,
  Component, ElementRef, OnDestroy, OnInit, ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { UsersService } from '../../services/users.service';
import { AuthService } from '../../services/auth.service';
import { SocketService } from '../../services/socket.service';
import api from '../../services/api.service';

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

  // Media streams
  localStream?: MediaStream;
  screenStream?: MediaStream;

  // WebRTC connections
  peerConnections: Map<number, RTCPeerConnection> = new Map();
  remoteStreams: Map<number, MediaStream[]> = new Map();

  // UI states
  isInCall = false;
  isScreenSharing = false;
  isCameraEnabled = false;
  isMicMuted = false;

  // ICE candidate buffers
  pendingCandidates: Map<number, RTCIceCandidate[]> = new Map();

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
  }

  async fetchInitialUsers() {
    console.log('[Users] Fetching initial users for room', this.roomId);
    this.users = [];
    try {
      const res = await api.get(`http://lamzaone.go.ro:8000/api/room/${this.roomId}/users`);
      const userIds: string[] = res.data['userIds'];
      this.voiceUserIds = new Set();
      this.users = await Promise.all(
        userIds.map(async (userId: string) => {
          const user = await this.userService.getUserInfo(userId);
          this.voiceUserIds.add(parseInt(userId));
          console.log('[Users] Found user:', user);
          return { ...user, id: parseInt(user.id) };
        })
      );
      this.cdr.detectChanges();
      console.log('[Users] Initial users loaded:', this.users);
    } catch (error) {
      console.error('[Users] Failed to fetch users', error);
    }
  }

  setupSocketListeners() {
    console.log('[Socket] Setting up socket listeners');
    this.socketService.onAudioRoomMessage((message: string) => {
      console.log('[Socket] Received message:', message);

      if (message.startsWith('user_joined_call')) {
        const userId = parseInt(message.split(':&')[1]);
        console.log('[Socket] User joined call:', userId);
        this.handleUserJoined(userId);
      } else if (message.startsWith('user_left_call')) {
        const userId = parseInt(message.split(':&')[1]);
        console.log('[Socket] User left call:', userId);
        this.handleUserLeft(userId);
      } else if (message === 'room_closed') {
        console.log('[Socket] Room closed message received');
        this.leaveCall();
      } else {
        try {
          const data = JSON.parse(message);
          console.log('[Socket] Parsed signaling data:', data);
          this.handleSignalingData(data);
        } catch (e) {
          console.log('[Socket] Non-JSON message:', message);
        }
      }
    });
  }

  private handleUserJoined(userId: number) {
    if (!this.voiceUserIds.has(userId)) {
      console.log('[UserJoin] Adding user to voice:', userId);
      this.voiceUserIds.add(userId);
      this.fetchInitialUsers();

      if (userId !== this.userId && this.isInCall) {
        console.log('[UserJoin] Creating peer connection for:', userId);
        this.createPeerConnection(userId);
      }
    }
  }

  private handleUserLeft(userId: number) {
      console.log('[UserLeave] Removing user from voice:', userId);
      this.voiceUserIds.delete(userId);
      this.fetchInitialUsers();
      this.closePeerConnection(userId);

  }

  private handleSignalingData(data: any) {
    if (!data.type) {
      console.log('[Signaling] Invalid signaling data - missing type:', data);
      return;
    }

    // Get sender from either data.sender or data.target (for backward compatibility)
    const userId = data.sender || data.target;
    if (!userId) {
      console.log('[Signaling] Invalid signaling data - missing user ID:', data);
      return;
    }

    console.log(`[Signaling] Received ${data.type} from user:`, userId);

    switch(data.type) {
      case 'offer':
        console.log('[Signaling] Handling offer with SDP:', data.sdp);
        this.handleOffer(data, userId);
        break;
      case 'answer':
        console.log('[Signaling] Handling answer with SDP:', data.sdp);
        this.handleAnswer(data, userId);
        break;
      case 'candidate':
      case 'ice-candidate':
        console.log('[Signaling] Handling ICE candidate:', data.candidate);
        this.handleCandidate(data, userId);
        break;
      default:
        console.log('[Signaling] Unknown signaling type:', data.type);
    }
  }

  async joinVoiceRoom() {
    if (this.isInCall) {
      console.log('[Call] Already in call, ignoring join request');
      return;
    }

    console.log('[Call] Joining voice room');
    try {
      console.log('[Media] Requesting user media');
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: this.isCameraEnabled
      });

      console.log('[Media] Got local media stream with tracks:',
        this.localStream.getTracks().map(t => `${t.kind} (${t.id})`));

      this.setLocalVideo(this.localStream);
      console.log('[Socket] Notifying others of join');
      this.socketService.sendMessage("user_joined_call:&"+this.userId, false, 'audioRoom');

      this.isInCall = true;
      this.isMicMuted = false;
      this.voiceUserIds.add(this.userId);

      console.log('[Call] Creating peer connections for existing users');
      this.users.forEach(user => {
        const userId = user.id;
        if (userId !== this.userId && this.voiceUserIds.has(userId)) {
          this.createPeerConnection(userId);
        }
      });
    } catch (error) {
      console.error('[Call] Error joining call:', error);
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        console.error('[Call] Microphone access was denied');
      }
    }

    this.voiceUserIds.add(this.userId);
    this.fetchInitialUsers();
  }

  private async createPeerConnection(userId: number) {

    if (this.peerConnections.has(userId)) {
      console.log(`[PeerConnection] Connection already exists for user: ${userId}`);
      return;
    }

    console.log(`[PeerConnection] Creating new connection for user: ${userId}`);
    const configuration = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        // Add TURN servers here if needed
      ],
      iceTransportPolicy: 'all' as RTCIceTransportPolicy,
      iceCandidatePoolSize: 10
    };

    const pc = new RTCPeerConnection(configuration);
    this.peerConnections.set(userId, pc);
    this.pendingCandidates.set(userId, []);

    pc.onconnectionstatechange = () => {
      console.log(`[Connection] State changed for user ${userId}: ${pc.connectionState}`);
      if (pc.connectionState === 'failed') {
        console.log(`[Connection] Attempting to restart ICE for user ${userId}`);
        pc.restartIce();
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[ICE] Connection state for user ${userId}: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
        console.log(`[ICE] Attempting to reconnect to user ${userId}`);
        setTimeout(() => {
          if (pc.iceConnectionState !== 'connected') {
            this.closePeerConnection(userId);
            this.createPeerConnection(userId);
          }
        }, 2000);
      }
    };

    console.log(`[PeerConnection] Adding local tracks to connection for user: ${userId}`);
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        const existingSender = pc.getSenders().find(s => s.track?.kind === track.kind);
        if (!existingSender) {
          console.log(`[PeerConnection] Adding ${track.kind} track to connection`);
          pc.addTrack(track, this.localStream!);
        }
      });
    }

    pc.ontrack = (event) => {
      console.log(`[PeerConnection] Received track event from user: ${userId}`, event);
      const streams = event.streams;
      if (!streams || streams.length === 0) return;

      let currentStreams = this.remoteStreams.get(userId) || [];
      streams.forEach(stream => {
        if (!currentStreams.some(s => s.id === stream.id)) {
          currentStreams = [...currentStreams, stream];
        }
      });
      this.remoteStreams.set(userId, currentStreams);

      // Handle audio tracks
      this.playAllAudioTracks(userId);

      // Handle video elements
      this.updateUserVideoElements();

      // Check for screen share (simplified example)
      const videoTrack = event.track.kind === 'video' ? event.track : null;
      if (videoTrack?.contentHint === 'detail' || videoTrack?.contentHint === 'text') {
        console.log(`[ScreenShare] Received screen share from ${userId}`);
      }
    };


    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log(`[ICE] Generated candidate for user ${userId}:`, event.candidate);
        this.socketService.sendMessage(
          JSON.stringify({
            type: 'ice-candidate',
            target: userId,
            candidate: event.candidate
          }),
          false,
          'audioRoom'
        );
      } else {
        console.log(`[ICE] ICE gathering complete for user ${userId}`);
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[ICE] Connection state for user ${userId}: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
        console.log(`[ICE] Closing connection with user ${userId} due to state: ${pc.iceConnectionState}`);
        this.closePeerConnection(userId);
      }
    };

    pc.onsignalingstatechange = () => {
      console.log(`[Signaling] State changed for user ${userId}: ${pc.signalingState}`);
    };

    try {
      console.log(`[PeerConnection] Creating offer for user ${userId}`);
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: this.isCameraEnabled || this.isScreenSharing
      });
      console.log(`[PeerConnection] Created offer for user ${userId}:`, offer);

      await pc.setLocalDescription(offer);
      console.log(`[PeerConnection] Set local description for user ${userId}`);

      this.socketService.sendMessage(
        JSON.stringify({
          type: 'offer',
          target: userId,
          sdp: offer.sdp
        }),
        false,
        'audioRoom'
      );
      console.log(`[PeerConnection] Sent offer to user ${userId}`);
      return pc;
    } catch (error) {
      console.error(`[PeerConnection] Error creating offer for user ${userId}:`, error);
      this.closePeerConnection(userId);
    }
  }


  private handleRemoteScreenShare(userId: number, stream: MediaStream) {
  if (!this.remoteVideoRef?.nativeElement) {
    console.error('[ScreenShare] Remote video container not found');
    return;
  }

  // Create or update existing video element
  let videoElement = this.remoteVideoRef.nativeElement.querySelector(`[data-screen-share="${userId}"]`) as HTMLVideoElement;

  if (!videoElement) {
    console.log(`[ScreenShare] Creating new video element for user ${userId}`);
    videoElement = document.createElement('video');
    videoElement.autoplay = true;
    videoElement.playsInline = true;
    videoElement.style.width = '100%';
    videoElement.style.maxHeight = '80vh';
    videoElement.setAttribute('data-screen-share', userId.toString());
    this.remoteVideoRef.nativeElement.appendChild(videoElement);
  }

  // Set the stream source
  videoElement.srcObject = stream;

  // Play the stream
  videoElement.play().catch(e => console.error('[ScreenShare] Error playing video:', e));

  // Clean up when stream ends
  stream.onremovetrack = () => {
    if (stream.getTracks().length === 0) {
      console.log(`[ScreenShare] Removing screen share from user ${userId}`);
      videoElement.remove();
    }
  };
}
  private async handleOffer(data: any, userId: number) {
    const isScreenShareOffer = data.screenShare === true;
    let pc = this.peerConnections.get(userId);

    // Only ignore non-screen-share offers when we already have a connection
    if (pc && !isScreenShareOffer) {
      console.log(`[Offer] Ignoring regular offer from user ${userId} - existing connection`);
      return;
    }

    if (!pc) {
      console.log(`[Offer] Creating new connection for ${userId}`);
      pc = await this.createPeerConnection(userId);
    }

    if (!pc) {
      console.error(`[Offer] Failed to create peer connection for ${userId}`);
      return;
    }

    try {
      console.log(`[Offer] Setting remote description for ${userId}`);
      await pc.setRemoteDescription(new RTCSessionDescription({
        type: 'offer',
        sdp: data.sdp
      }));

      // Process any pending ICE candidates
      const pending = this.pendingCandidates.get(userId) || [];
      console.log(`[Offer] Processing ${pending.length} pending candidates for ${userId}`);
      for (const candidate of pending) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (e) {
          console.error(`[Offer] Error adding pending candidate for ${userId}:`, e);
        }
      }
      this.pendingCandidates.set(userId, []);

      console.log(`[Offer] Creating answer for ${userId}`);
      const answer = await pc.createAnswer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true // Always true to handle both camera and screen share
      });

      await pc.setLocalDescription(answer);

      this.socketService.sendMessage(
        JSON.stringify({
          type: 'answer',
          target: userId,
          sdp: answer.sdp,
          screenShare: isScreenShareOffer
        }),
        false,
        'audioRoom'
      );
    } catch (error) {
      console.error(`[Offer] Error handling offer from ${userId}:`, error);
      this.closePeerConnection(userId);
    }
  }

  private async handleAnswer(data: any, userId: number) {
    const pc = this.peerConnections.get(userId);
    if (!pc || pc.signalingState !== 'have-local-offer') {
      console.log(`[Answer] Ignoring answer from user ${userId} - invalid state`);
      return;
    }

    console.log(`[Answer] Handling answer from user ${userId}`);
    try {
      await pc.setRemoteDescription(new RTCSessionDescription({
        type: 'answer',
        sdp: data.sdp
      }));
      console.log(`[Answer] Set remote description for user ${userId}`);

      const pending = this.pendingCandidates.get(userId) || [];
      console.log(`[Answer] Processing ${pending.length} pending candidates for user ${userId}`);
      for (const candidate of pending) {
        try {
          await pc.addIceCandidate(candidate);
          console.log(`[Answer] Added pending ICE candidate for user ${userId}`);
        } catch (e) {
          console.error(`[Answer] Error adding pending candidate for user ${userId}:`, e);
        }
      }
      this.pendingCandidates.set(userId, []);
    } catch (error) {
      console.error(`[Answer] Error handling answer from user ${userId}:`, error);
      this.closePeerConnection(userId);
    }
  }

  private async handleCandidate(data: any, userId: number) {
    const pc = this.peerConnections.get(userId);
    if (!pc) {
      console.log(`[ICE] No peer connection for candidate from user ${userId}`);
      return;
    }

    try {
      // Handle both direct candidate and nested candidate formats
      const candidateData = data.candidate ? data.candidate : data;
      const candidate = new RTCIceCandidate({
        candidate: candidateData.candidate,
        sdpMid: candidateData.sdpMid || '0',
        sdpMLineIndex: candidateData.sdpMLineIndex || 0,
        usernameFragment: candidateData.usernameFragment
      });

      console.log(`[ICE] Processing candidate for user ${userId}:`, candidate);

      // Try to add immediately, if that fails, buffer it
      try {
        await pc.addIceCandidate(candidate);
        console.log(`[ICE] Successfully added candidate for user ${userId}`);
      } catch (error) {
        console.log(`[ICE] Buffering candidate for user ${userId} (${error})`);
        const pending = this.pendingCandidates.get(userId) || [];
        pending.push(candidate);
        this.pendingCandidates.set(userId, pending);
      }
    } catch (error) {
      console.error(`[ICE] Error processing candidate for user ${userId}:`, error);
    }
  }

  private playAllAudioTracks(userId: number) {
    const streams = this.remoteStreams.get(userId) || [];
    streams.forEach(stream => {
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length > 0) {
        this.playAudioStream(stream);
      }
    });
  }

  private playAudioStream(stream: MediaStream) {
    const existingAudio = this.audioContainerRef?.nativeElement.querySelector(`audio[data-stream-id="${stream.id}"]`);
    if (existingAudio) return;

    const audioElement = document.createElement('audio');
    audioElement.setAttribute('data-stream-id', stream.id);
    audioElement.srcObject = stream;
    audioElement.autoplay = true;
    audioElement.style.display = 'none';

    (this.audioContainerRef?.nativeElement || document.body).appendChild(audioElement);

    audioElement.play().catch(e => {
      console.error('[Audio] Error playing audio:', e);
      document.addEventListener('click', () => audioElement.play(), { once: true });
    });

    stream.onremovetrack = () => {
      if (stream.getTracks().length === 0) {
        audioElement.remove();
      }
    };
  }

  private closePeerConnection(userId: number) {
    const pc = this.peerConnections.get(userId);
    if (pc) {
      pc.close();
      this.peerConnections.delete(userId);
      this.remoteStreams.delete(userId);
      this.pendingCandidates.delete(userId);
      this.updateUserVideoElements();
    }
  }

  private setLocalVideo(stream?: MediaStream) {
    if (this.localVideoRef?.nativeElement) {
      console.log('[Video] Setting local video stream');
      this.localVideoRef.nativeElement.srcObject = stream || null;
      if (stream) {
        this.localVideoRef.nativeElement.muted = true;
      }
    }
  }

  leaveCall() {
    if (!this.isInCall) {
      console.log('[Call] Not in call, ignoring leave request');
      return;
    }

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

    console.log('[Socket] Notifying others of leave');
    this.socketService.sendMessage("user_left_call:&"+this.userId, false, 'audioRoom');

    this.isInCall = false;
    this.isCameraEnabled = false;
    this.isScreenSharing = false;
    this.isMicMuted = false;
    this.voiceUserIds.delete(this.userId);

    if (this.localVideoRef?.nativeElement) {
      this.localVideoRef.nativeElement.srcObject = null;
    }
    if (this.remoteVideoRef?.nativeElement) {
      this.remoteVideoRef.nativeElement.innerHTML = '';
    }
  }

  private updateUserVideoElements() {
    setTimeout(() => {
      this.users.forEach(user => {
        const userId = user.id;
        const streams = this.remoteStreams.get(userId) || [];
        let screenStream: MediaStream | undefined;
        let cameraStream: MediaStream | undefined;

        streams.forEach(stream => {
          const videoTracks = stream.getVideoTracks();
          if (videoTracks.length > 0) {
            const isScreenShare = videoTracks.some(track =>
              track.contentHint === 'detail' || track.contentHint === 'text'
            );
            isScreenShare ? (screenStream = stream) : (cameraStream = stream);
          }
        });

        const videoElements = document.querySelectorAll(`video[data-user-id="${userId}"]`);
        videoElements.forEach(video => {
          if (video instanceof HTMLVideoElement) {
            video.srcObject = screenStream || cameraStream || null;
            video.play().catch(e => console.error('[Video] Error:', e));
          }
        });
      });
      this.cdr.detectChanges();
    });
  }

  async toggleCamera() {
    console.log('[Camera] Toggling camera', this.isCameraEnabled);
    if (!this.isInCall) return;

    this.isCameraEnabled = !this.isCameraEnabled;

    if (this.isCameraEnabled) {
      try {
        console.log('[Camera] Enabling camera');
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        const videoTrack = stream.getVideoTracks()[0];
        console.log('[Camera] Got video track:', videoTrack.id);

        if (!this.localStream) {
          console.log('[Camera] Creating new local stream');
          this.localStream = new MediaStream();
          const audioTracks = await navigator.mediaDevices.getUserMedia({ audio: true });
          audioTracks.getAudioTracks().forEach(track => this.localStream!.addTrack(track));
        } else {
          console.log('[Camera] Replacing existing video tracks');
          this.localStream.getVideoTracks().forEach(track => track.stop());
        }

        this.localStream.addTrack(videoTrack);
        this.setLocalVideo(this.localStream);
        this.updateTracksForAllPeers();
      } catch (error) {
        console.error('[Camera] Error accessing camera:', error);
        this.isCameraEnabled = false;
      }
    } else {
      console.log('[Camera] Disabling camera');
      if (this.localStream) {
        this.localStream.getVideoTracks().forEach(track => track.stop());
        this.setLocalVideo(this.localStream);
        this.updateTracksForAllPeers();
      }
    }
  }



  async toggleScreenShare() {
    if (this.isScreenSharing) {
      await this.stopScreenShare();
      return;
    }

    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      this.screenStream = screenStream;
      this.isScreenSharing = true;

      this.peerConnections.forEach((pc, userId) => {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) {
          sender.replaceTrack(screenStream.getVideoTracks()[0]);
        } else {
          pc.addTrack(screenStream.getVideoTracks()[0], screenStream);
        }
      });

      this.cdr.detectChanges();
    } catch (error) {
      console.error('[ScreenShare] Error:', error);
      this.isScreenSharing = false;
    }
  }

private async renegotiatePeerConnection(pc: RTCPeerConnection, userId: number, isScreenShare: boolean) {
  try {
    console.log(`[Renegotiate] Creating new offer for ${userId}`);
    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true
    });

    await pc.setLocalDescription(offer);

    this.socketService.sendMessage(
      JSON.stringify({
        type: 'offer',
        target: userId,
        sdp: offer.sdp,
        screenShare: isScreenShare
      }),
      false,
      'audioRoom'
    );
  } catch (error) {
    console.error(`[Renegotiate] Error for ${userId}:`, error);
  }
}

async stopScreenShare() {
  if (!this.isScreenSharing) return;

  console.log('[ScreenShare] Stopping screen share');

  if (this.screenStream) {
    this.screenStream.getTracks().forEach(track => track.stop());
    this.screenStream = undefined;
  }

  this.isScreenSharing = false;

  // Restore camera if enabled
  if (this.isCameraEnabled && this.localStream) {
    const cameraTrack = this.localStream.getVideoTracks()[0];
    if (cameraTrack) {
      this.peerConnections.forEach(async (pc, userId) => {
        const senders = pc.getSenders();
        const videoSender = senders.find(s => s.track?.kind === 'video');

        if (videoSender) {
          await videoSender.replaceTrack(cameraTrack);
          console.log(`[ScreenShare] Restored camera track for ${userId}`);
        }

        // Renegotiate connection without screen share
        await this.renegotiatePeerConnection(pc, userId, false);
      });
    }
  }

  // Restore local video
  this.setLocalVideo(this.localStream || undefined);
  this.cdr.detectChanges();
}

private async renegotiateAllPeerConnections() {
  for (const [userId, pc] of this.peerConnections) {
    try {
      console.log(`[Renegotiate] Creating new offer for ${userId}`);
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });

      await pc.setLocalDescription(offer);

      this.socketService.sendMessage(
        JSON.stringify({
          type: 'offer',
          target: userId,
          sdp: offer.sdp,
          screenShare: true // Indicate this is for screen sharing
        }),
        false,
        'audioRoom'
      );
    } catch (error) {
      console.error(`[Renegotiate] Error for ${userId}:`, error);
    }
  }
}


  toggleMic() {
    console.log('[Mic] Toggling mic mute', this.isMicMuted);
    if (!this.isInCall || !this.localStream) return;
    this.isMicMuted = !this.isMicMuted;
    this.localStream.getAudioTracks().forEach(track => {
      track.enabled = !this.isMicMuted;
      console.log(`[Mic] ${track.enabled ? 'Unmuted' : 'Muted'} audio track:`, track.id);
    });
  }

  private updateTracksForAllPeers() {
    console.log('[Tracks] Updating tracks for all peers');
    if (!this.localStream) return;

    this.peerConnections.forEach((pc, userId) => {
      console.log(`[Tracks] Updating tracks for user ${userId}`);
      const senders = pc.getSenders();

      // Update audio track
      const audioTrack = this.localStream!.getAudioTracks()[0];
      const audioSender = senders.find(s => s.track?.kind === 'audio');
      if (audioSender && audioTrack) {
        console.log(`[Tracks] Replacing audio track for user ${userId}`);
        audioSender.replaceTrack(audioTrack).catch(err => {
          console.error(`[Tracks] Error replacing audio track for user ${userId}:`, err);
        });
      }

      // Update video track
      let videoTrack: MediaStreamTrack | null = null;
      if (this.isScreenSharing && this.screenStream) {
        console.log(`[Tracks] Using screen share video track for user ${userId}`);
        videoTrack = this.screenStream.getVideoTracks()[0];
      } else if (this.isCameraEnabled && this.localStream) {
        console.log(`[Tracks] Using camera video track for user ${userId}`);
        videoTrack = this.localStream.getVideoTracks()[0];
      }

      const videoSender = senders.find(s => s.track?.kind === 'video');
      if (videoSender) {
        if (videoTrack) {
          console.log(`[Tracks] Replacing video track for user ${userId}`);
          videoSender.replaceTrack(videoTrack).catch(err => {
            console.error(`[Tracks] Error replacing video track for user ${userId}:`, err);
          });
        } else {
          console.log(`[Tracks] Removing video track for user ${userId}`);
          pc.removeTrack(videoSender);
        }
      }
    });
  }
}
