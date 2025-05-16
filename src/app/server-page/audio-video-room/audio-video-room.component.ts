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

  roomId: number = 14;
  userId = this.authService.getUser().id;

  users: any[] = [];
  voiceUserIds: Set<number> = new Set();

  // Media streams
  localStream?: MediaStream;
  screenStream?: MediaStream;

  // WebRTC connections
  peerConnections: Map<number, RTCPeerConnection> = new Map();
  remoteStreams: Map<number, MediaStream> = new Map();

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
      if (event.streams && event.streams[0]) {
        const remoteStream = event.streams[0];
        console.log(`[PeerConnection] Got remote stream with tracks:`,
          remoteStream.getTracks().map(t => `${t.kind} (${t.id})`));

        this.remoteStreams.set(userId, remoteStream);

        // Handle audio tracks
        const audioTracks = remoteStream.getAudioTracks();
        if (audioTracks.length > 0) {
          console.log(`[PeerConnection] Found ${audioTracks.length} audio tracks`);
          this.playAudioStream(remoteStream);
        }

        // Handle video tracks
        if (remoteStream.getVideoTracks().length > 0) {
          console.log(`[PeerConnection] Found video tracks, updating UI`);
          this.updateUserVideoElements();
        }
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
    } catch (error) {
      console.error(`[PeerConnection] Error creating offer for user ${userId}:`, error);
      this.closePeerConnection(userId);
    }
  }

  private async handleOffer(data: any, userId: number) {
    if (!userId || this.peerConnections.has(userId)) {
      console.log(`[Offer] Ignoring offer from user ${userId} - invalid or existing connection`);
      return;
    }

    console.log(`[Offer] Handling offer from user ${userId}`);
    await this.createPeerConnection(userId);
    const pc = this.peerConnections.get(userId)!;

    try {
      console.log(`[Offer] Setting remote description for user ${userId}`);
      await pc.setRemoteDescription(new RTCSessionDescription({
        type: 'offer',
        sdp: data.sdp
      }));

      const pending = this.pendingCandidates.get(userId) || [];
      console.log(`[Offer] Processing ${pending.length} pending candidates for user ${userId}`);
      for (const candidate of pending) {
        try {
          await pc.addIceCandidate(candidate);
          console.log(`[Offer] Added pending ICE candidate for user ${userId}`);
        } catch (e) {
          console.error(`[Offer] Error adding pending candidate for user ${userId}:`, e);
        }
      }
      this.pendingCandidates.set(userId, []);

      console.log(`[Offer] Creating answer for user ${userId}`);
      const answer = await pc.createAnswer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: this.isCameraEnabled || this.isScreenSharing
      });
      console.log(`[Offer] Created answer for user ${userId}:`, answer);

      await pc.setLocalDescription(answer);
      console.log(`[Offer] Set local description for user ${userId}`);

      this.socketService.sendMessage(
        JSON.stringify({
          type: 'answer',
          target: userId,
          sdp: answer.sdp
        }),
        false,
        'audioRoom'
      );
      console.log(`[Offer] Sent answer to user ${userId}`);
    } catch (error) {
      console.error(`[Offer] Error handling offer from user ${userId}:`, error);
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

  private playAudioStream(stream: MediaStream) {
    console.log(`[Audio] Setting up playback for stream with ${stream.getAudioTracks().length} audio tracks`);
    const audioElement = document.createElement('audio');
    audioElement.srcObject = stream;
    audioElement.autoplay = true;
    audioElement.style.display = 'none';

    if (this.audioContainerRef?.nativeElement) {
      this.audioContainerRef.nativeElement.appendChild(audioElement);
    } else {
      document.body.appendChild(audioElement);
    }

    audioElement.play().catch(e => {
      console.error('[Audio] Error playing audio:', e);
      document.addEventListener('click', () => {
        audioElement.play().catch(e => console.error('[Audio] Still cannot play audio:', e));
      }, { once: true });
    });

    stream.onremovetrack = () => {
      if (stream.getTracks().length === 0) {
        console.log('[Audio] Removing audio element as stream ended');
        audioElement.remove();
      }
    };
  }

  private closePeerConnection(userId: number) {
    const pc = this.peerConnections.get(userId);
    if (pc) {
      console.log(`[PeerConnection] Closing connection with user ${userId}`);
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
  }

  private updateUserVideoElements() {
    setTimeout(() => {
      console.log('[UI] Updating video elements for remote streams');
      this.users.forEach(user => {
        const userId = user.id;
        const remoteStream = this.remoteStreams.get(userId);
        const videoElements = document.querySelectorAll(`video[data-user-id="${userId}"]`);

        videoElements.forEach(video => {
          if (video instanceof HTMLVideoElement) {
            video.srcObject = remoteStream || null;
            if (remoteStream) {
              video.play().catch(e => console.error('[Video] Error playing video:', e));
            }
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
    console.log('[ScreenShare] Toggling screen share', this.isScreenSharing);
    if (!this.isInCall) return;

    try {
      if (!this.isScreenSharing) {
        console.log('[ScreenShare] Starting screen share');
        this.screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false // Change to true if you want to share system audio
        });

        // Replace video tracks in all peer connections
        this.peerConnections.forEach((pc, peerId) => {
          const senders = pc.getSenders();
          const videoSender = senders.find(s => s.track?.kind === 'video');
          if (videoSender && this.screenStream) {
            const videoTrack = this.screenStream.getVideoTracks()[0];
            videoSender.replaceTrack(videoTrack)
              .then(() => console.log(`[ScreenShare] Replaced video track for peer ${peerId}`))
              .catch(err => console.error(`[ScreenShare] Error replacing track for peer ${peerId}:`, err));
          }
        });

        this.isScreenSharing = true;

        // Handle when screen share is stopped by user
        this.screenStream.getVideoTracks()[0].onended = () => {
          console.log('[ScreenShare] User ended screen share');
          this.stopScreenShare();
        };
      } else {
        console.log('[ScreenShare] Stopping screen share');
        this.stopScreenShare();
      }
    } catch (error) {
      console.error('[ScreenShare] Error toggling screen share:', error);
      this.isScreenSharing = false;
    }
  }

  private stopScreenShare() {
    console.log('[ScreenShare] Stopping screen share');
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(track => track.stop());
      this.screenStream = undefined;
    }
    this.isScreenSharing = false;
    this.updateTracksForAllPeers();
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
