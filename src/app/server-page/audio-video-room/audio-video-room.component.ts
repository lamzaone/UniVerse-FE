import {
  ChangeDetectorRef,
  Component, ElementRef, OnDestroy, OnInit, ViewChild
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

  isInCall = false;
  isScreenSharing = false;
  isCameraEnabled = false;
  isMicMuted = false;

  pendingCandidates = new Map<number, RTCIceCandidate[]>();

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

  private setupSocketListeners() {
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
          console.log('Non-JSON message:', message);
        }
      }
    });
  }

  private handleUserJoined(userId: number) {
    if (!this.voiceUserIds.has(userId)) {
      this.voiceUserIds.add(userId);
      if (this.isInCall) this.createPeerConnection(userId);
      this.fetchInitialUsers();
    }
  }

  private handleUserLeft(userId: number) {
    this.voiceUserIds.delete(userId);
    this.closePeerConnection(userId);
    this.fetchInitialUsers();
  }

  private createPeerConnection(userId: number): void {

    if (this.peerConnections.has(userId)) return;
    if (this.userId < userId) {
      this.negotiateConnection(userId);
    }

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    const peer: PeerConnection = { pc, streams: {} };
    this.peerConnections.set(userId, peer);
    this.pendingCandidates.set(userId, []);

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

    pc.ontrack = (event) => {
      const stream = event.streams[0];
      const track = event.track;

      if (track.kind === 'audio') {
        const audio = document.createElement('audio');
        audio.srcObject = stream;
        audio.autoplay = true;
        this.audioContainerRef.nativeElement.appendChild(audio);
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
        this.cdr.detectChanges();
      }
    };

    pc.onconnectionstatechange = () => {
      if (["disconnected", "failed"].includes(pc.connectionState)) {
        this.reconnectPeer(userId);
      }
    };

    this.updatePeerTracks(peer);
    this.negotiateConnection(userId);
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
    const container = this.remoteVideoRef.nativeElement;
    const streams = this.remoteStreams.get(userId) || {};

    const cameraVideo = container.querySelector<HTMLVideoElement>(
      `video.camera-video[data-user-id="${userId}"]`
    );
    if (cameraVideo) cameraVideo.srcObject = streams.camera || null;

    const screenVideo = container.querySelector<HTMLVideoElement>(
      `video.screen-share[data-user-id="${userId}"]`
    );
    if (screenVideo) screenVideo.srcObject = streams.screen || null;
  }

  async joinVoiceRoom() {
    if (this.isInCall) return;

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: this.isCameraEnabled
      });

      if (this.localVideoRef?.nativeElement) {
        this.localVideoRef.nativeElement.srcObject = this.localStream;
      }

      this.isInCall = true;
      this.socketService.sendMessage(`user_joined_call:&${this.userId}`, false, 'audioRoom');

      this.users.forEach(user => {
        if (user.id !== this.userId) this.createPeerConnection(user.id);
      });
    } catch (error) {
      console.error('Error joining call:', error);
    }
  }

  async toggleScreenShare() {
    this.isScreenSharing = !this.isScreenSharing;

    if (this.isScreenSharing) {
      try {
        this.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        this.screenStream.getVideoTracks()[0].contentHint = 'detail';
      } catch (err) {
        console.error('Failed to share screen:', err);
        this.isScreenSharing = false;
        return;
      }
    } else {
      this.screenStream?.getTracks().forEach(track => track.stop());
      this.screenStream = undefined;
    }

    this.peerConnections.forEach((peer, userId) => {
      this.updatePeerTracks(peer);
      this.negotiateConnection(userId);
    });
  }

  async toggleCamera() {
    this.isCameraEnabled = !this.isCameraEnabled;

    if (this.isCameraEnabled) {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      this.localStream?.getVideoTracks().forEach(track => track.stop());
      stream.getVideoTracks().forEach(track => this.localStream?.addTrack(track));
    } else {
      this.localStream?.getVideoTracks().forEach(track => track.stop());
    }

    this.localVideoRef.nativeElement.srcObject = this.localStream || null;
    this.peerConnections.forEach((peer, userId) => this.updatePeerTracks(peer));
  }

  private negotiateConnection(userId: number) {
    const peer = this.peerConnections.get(userId);
    if (!peer || peer.pc.signalingState !== 'stable') return;

    peer.pc.createOffer().then(offer => {
      return peer.pc.setLocalDescription(offer);
    }).then(() => {
      this.socketService.sendMessage(
        JSON.stringify({ type: 'offer', target: userId, sdp: peer.pc.localDescription!.sdp }),
        false,
        'audioRoom'
      );
    }).catch(error => {
      console.error('Negotiation error:', error);
    });
  }


  private handleSignalingData(data: any) {
    const userId = data.sender || data.target;
    if (!userId) return;

    switch (data.type) {
      case 'offer': this.handleOffer(userId, data); break;
      case 'answer': this.handleAnswer(userId, data); break;
      case 'ice-candidate': this.handleCandidate(userId, data.candidate); break;
    }
  }

  private async handleOffer(userId: number, offer: any) {
    let peer = this.peerConnections.get(userId);
    if (!peer) {
      this.createPeerConnection(userId);
      peer = this.peerConnections.get(userId);
    }
    if (!peer) return;

    try {
      if (peer.pc.signalingState !== 'stable') {
        console.warn(`Peer ${userId} is not stable, skipping offer`);
        return;
      }

      await peer.pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      this.socketService.sendMessage(
        JSON.stringify({ type: 'answer', target: userId, sdp: answer.sdp }),
        false,
        'audioRoom'
      );

      const pending = this.pendingCandidates.get(userId) || [];
      pending.forEach(c => peer!.pc.addIceCandidate(c));
      this.pendingCandidates.set(userId, []);
    } catch (error) {
      console.error('Offer handling error:', error);
    }
  }


  private async handleAnswer(userId: number, answer: any) {
    const peer = this.peerConnections.get(userId);
    if (peer) await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  private handleCandidate(userId: number, candidate: any) {
    const peer = this.peerConnections.get(userId);
    const rtcCandidate = new RTCIceCandidate(candidate);
    if (peer) {
      peer.pc.addIceCandidate(rtcCandidate);
    } else {
      const pending = this.pendingCandidates.get(userId) || [];
      pending.push(rtcCandidate);
      this.pendingCandidates.set(userId, pending);
    }
  }

  private closePeerConnection(userId: number) {
    const peer = this.peerConnections.get(userId);
    if (peer) {
      peer.pc.close();
      this.peerConnections.delete(userId);
      this.remoteStreams.delete(userId);
    }
  }

  private reconnectPeer(userId: number) {
    this.closePeerConnection(userId);
    this.createPeerConnection(userId);
  }

  leaveCall() {
    this.peerConnections.forEach((_, userId) => this.closePeerConnection(userId));
    this.localStream?.getTracks().forEach(track => track.stop());
    this.screenStream?.getTracks().forEach(track => track.stop());

    this.isInCall = false;
    this.isCameraEnabled = false;
    this.isScreenSharing = false;

    this.socketService.sendMessage(`user_left_call:&${this.userId}`, false, 'audioRoom');
  }

  toggleMic() {
    this.isMicMuted = !this.isMicMuted;
    this.localStream?.getAudioTracks().forEach(track => {
      track.enabled = !this.isMicMuted;
    });
  }
}
