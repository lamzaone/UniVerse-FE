import {
  ChangeDetectorRef,
  Component, ElementRef, OnDestroy, OnInit, ViewChild
} from '@angular/core';
import { UsersService } from '../../services/users.service';
import { AuthService } from '../../services/auth.service';
import { SocketService } from '../../services/socket.service';
import api from '../../services/api.service';
interface PeerConnection {
  pc: RTCPeerConnection;
  senders: {
    audio?: RTCRtpSender;
    camera?: RTCRtpSender;
    screen?: RTCRtpSender;
  };
}

@Component({
  selector: 'app-audio-video-room',
  templateUrl: './audio-video-room.component.html',
  styleUrls: ['./audio-video-room.component.scss']
})
export class AudioVideoRoomComponent implements OnInit, OnDestroy {
  @ViewChild('localVideo', { static: false }) localVideoRef!: ElementRef<HTMLVideoElement>;
  @ViewChild('remoteContainer', { static: false }) remoteContainerRef!: ElementRef<HTMLDivElement>;

  roomId: number = 14;
  userId = this.authService.getUser().id;
  users: any[] = [];
  voiceUserIds: Set<number> = new Set();

  // Local media tracks
  localTracks = {
    audio: null as MediaStreamTrack | null,
    camera: null as MediaStreamTrack | null,
    screen: null as MediaStreamTrack | null
  };

  // WebRTC connections
  peerConnections = new Map<number, PeerConnection>();
  remoteStreams = new Map<number, {
    audio?: MediaStream;
    camera?: MediaStream;
    screen?: MediaStream;
  }>();

  constructor(
    private userService: UsersService,
    private authService: AuthService,
    private socketService: SocketService,
    private cdr: ChangeDetectorRef
  ) {}

  async ngOnInit() {
    await this.fetchInitialUsers();
    this.setupSocketListeners();
    this.socketService.joinAudioRoom(this.roomId.toString());
  }

  ngOnDestroy() {
    this.leaveCall();
  }

  async fetchInitialUsers() {
    try {
      const res = await api.get(`http://lamzaone.go.ro:8000/api/room/${this.roomId}/users`);
      this.users = res.data.map((user: any) => ({ ...user, id: parseInt(user.id) }));
      this.voiceUserIds = new Set(this.users.map(user => user.id));
      this.cdr.detectChanges();
    } catch (error) {
      console.error('Failed to fetch users', error);
    }
  }

  setupSocketListeners() {
    this.socketService.onAudioRoomMessage((message: string) => {
      console.log('[Socket] Received:', message);

      if (message.startsWith('user_joined_call')) {
        const userId = parseInt(message.split(':&')[1]);
        this.handleUserJoined(userId);
      } else if (message.startsWith('user_left_call')) {
        const userId = parseInt(message.split(':&')[1]);
        this.handleUserLeft(userId);
      } else if (message === 'room_closed') {
        this.leaveCall();
      } else {
        try {
          const data = JSON.parse(message);
          this.handleSignalingData(data);
        } catch {
          console.log('Non-JSON message:', message);
        }
      }
    });
  }

  private async createPeerConnection(userId: number): Promise<RTCPeerConnection> {
    if (this.peerConnections.has(userId)) {
      return this.peerConnections.get(userId)!.pc;
    }

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    const peer: PeerConnection = { pc, senders: {} };
    this.peerConnections.set(userId, peer);

    // Add existing local tracks
    this.updatePeerSenders(peer);

    pc.ontrack = (event) => {
      const stream = event.streams[0];
      const track = event.track;
      const isScreen = track.kind === 'video' && track.contentHint === 'detail';

      this.updateRemoteStream(userId, track.kind as 'audio' | 'video', stream, isScreen);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socketService.sendMessage(
          JSON.stringify({
            type: 'ice-candidate',
            target: userId,
            candidate: event.candidate
          }),
          false,
          'audioRoom'
        );
      }
    };

    return pc;
  }

  private updateRemoteStream(userId: number, kind: 'audio' | 'video', stream: MediaStream, isScreen: boolean) {
    const remote = this.remoteStreams.get(userId) || {};

    if (kind === 'audio') {
      remote.audio = stream;
    } else {
      if (isScreen) {
        remote.screen = stream;
      } else {
        remote.camera = stream;
      }
    }

    this.remoteStreams.set(userId, remote);
    this.updateVideoElements(userId);
  }

  private updateVideoElements(userId: number) {
    const container = this.remoteContainerRef.nativeElement;
    const streams = this.remoteStreams.get(userId) || {};

    ['camera', 'screen'].forEach(type => {
      const elementId = `video-${userId}-${type}`;
      let video = container.querySelector(`#${elementId}`) as HTMLVideoElement;

      if (streams[type as keyof typeof streams]) {
        if (!video) {
          video = document.createElement('video');
          video.id = elementId;
          video.autoplay = true;
          video.playsInline = true;
          video.className = type;
          container.appendChild(video);
        }
        video.srcObject = streams[type as keyof typeof streams]!;
        video.play().catch(console.error);
      } else if (video) {
        video.remove();
      }
    });

    this.cdr.detectChanges();
  }

  async toggleAudio() {
    if (this.localTracks.audio) {
      this.localTracks.audio.stop();
      this.localTracks.audio = null;
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.localTracks.audio = stream.getAudioTracks()[0];
    }
    this.updateLocalTracks();
  }

  async toggleCamera() {
    if (this.localTracks.camera) {
      this.localTracks.camera.stop();
      this.localTracks.camera = null;
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      this.localTracks.camera = stream.getVideoTracks()[0];
    }
    this.updateLocalTracks();
  }

  async toggleScreenShare() {
    if (this.localTracks.screen) {
      this.localTracks.screen.stop();
      this.localTracks.screen = null;
    } else {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = stream.getVideoTracks()[0];
      track.contentHint = 'detail';
      this.localTracks.screen = track;
    }
    this.updateLocalTracks();
  }

  private updateLocalTracks() {
    // Update local video preview
    const localStream = new MediaStream([
      ...(this.localTracks.camera ? [this.localTracks.camera] : []),
      ...(this.localTracks.screen ? [this.localTracks.screen] : [])
    ]);
    this.localVideoRef.nativeElement.srcObject = localStream;

    // Update all peer connections
    this.peerConnections.forEach((peer, userId) => {
      this.updatePeerSenders(peer);
      this.renegotiateConnection(userId);
    });
  }

  private updatePeerSenders(peer: PeerConnection) {
    // Audio
    this.updateSender(peer, 'audio', this.localTracks.audio);
    // Camera
    this.updateSender(peer, 'camera', this.localTracks.camera);
    // Screen
    this.updateSender(peer, 'screen', this.localTracks.screen);
  }

  private updateSender(peer: PeerConnection, type: keyof typeof this.localTracks, track: MediaStreamTrack | null) {
    const sender = peer.senders[type];

    if (track) {
      if (sender) {
        sender.replaceTrack(track);
      } else {
        peer.senders[type] = peer.pc.addTrack(track);
      }
    } else if (sender) {
      peer.pc.removeTrack(sender);
      peer.senders[type] = undefined;
    }
  }

  private async renegotiateConnection(userId: number) {
    const peer = this.peerConnections.get(userId);
    if (!peer) return;

    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);

      this.socketService.sendMessage(
        JSON.stringify({
          type: 'offer',
          target: userId,
          sdp: offer.sdp
        }),
        false,
        'audioRoom'
      );
    } catch (error) {
      console.error('Renegotiation failed:', error);
    }
  }

  private async handleUserJoined(userId: number) {
    if (userId === this.userId || this.peerConnections.has(userId)) return;

    try {
      const pc = await this.createPeerConnection(userId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      this.socketService.sendMessage(
        JSON.stringify({
          type: 'offer',
          target: userId,
          sdp: offer.sdp
        }),
        false,
        'audioRoom'
      );
    } catch (error) {
      console.error('Error creating peer connection:', error);
    }
  }

  private handleUserLeft(userId: number) {
    const peer = this.peerConnections.get(userId);
    if (peer) {
      peer.pc.close();
      this.peerConnections.delete(userId);
    }
    this.remoteStreams.delete(userId);
    this.updateVideoElements(userId);
  }

  private async handleSignalingData(data: any) {
    if (!data.type) return;

    const userId = data.sender || data.target;
    if (!userId) return;

    switch(data.type) {
      case 'offer':
        await this.handleOffer(userId, data);
        break;
      case 'answer':
        await this.handleAnswer(userId, data);
        break;
      case 'ice-candidate':
        await this.handleCandidate(userId, data);
        break;
    }
  }

  private async handleOffer(userId: number, offer: any) {
    const pc = await this.createPeerConnection(userId);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this.socketService.sendMessage(
      JSON.stringify({
        type: 'answer',
        target: userId,
        sdp: answer.sdp
      }),
      false,
      'audioRoom'
    );
  }

  private async handleAnswer(userId: number, answer: any) {
    const peer = this.peerConnections.get(userId);
    if (peer) {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
  }

  private async handleCandidate(userId: number, candidateData: any) {
    const peer = this.peerConnections.get(userId);
    if (peer && candidateData.candidate) {
      await peer.pc.addIceCandidate(new RTCIceCandidate(candidateData.candidate));
    }
  }

  leaveCall() {
    this.peerConnections.forEach(peer => peer.pc.close());
    this.peerConnections.clear();

    Object.values(this.localTracks).forEach(track => track?.stop());
    this.localTracks = { audio: null, camera: null, screen: null };

    this.remoteStreams.clear();
    this.localVideoRef.nativeElement.srcObject = null;
    this.voiceUserIds.clear();

    this.socketService.sendMessage(`user_left_call:&${this.userId}`, false, 'audioRoom');
  }
}
