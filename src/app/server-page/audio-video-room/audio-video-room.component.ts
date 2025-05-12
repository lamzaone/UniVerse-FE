import {
  Component, ElementRef, OnDestroy, OnInit, ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { UsersService } from '../../services/users.service';
import { AuthService } from '../../services/auth.service';
import { SocketService } from '../../services/socket.service';
import api from '../../services/api.service';

@Component({
  selector: 'app-audio-video-room',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './audio-video-room.component.html',
  styleUrl: './audio-video-room.component.scss'
})
export class AudioVideoRoomComponent implements OnInit, OnDestroy {
  @ViewChild('localVideo') localVideoRef!: ElementRef<HTMLVideoElement>;

  roomId: any;
  userId = this.authService.getUser().id;

  audioStream!: MediaStream;
  cameraStream!: MediaStream;
  screenStream!: MediaStream;
  localStream!: MediaStream;

  peers: Map<number, RTCPeerConnection> = new Map();

  users: any[] = [];
  voiceUserIds: Set<number> = new Set();

  connected = false;

  isScreenSharing = false;
  isCameraEnabled = false;
  isMicEnabled = true;

  constructor(
    private userService: UsersService,
    private authService: AuthService,
    private router: Router,
    private socketService: SocketService
  ) {}

  async ngOnInit() {
    this.roomId = 3;
    await this.fetchInitialUsers();
    this.initSocketListeners();
    this.socketService.joinAudioRoom(this.roomId);
  }

  ngOnDestroy() {
    this.leave();
  }

  async fetchInitialUsers() {
    this.users = [];
    try {
      const res = await api.get(`http://lamzaone.go.ro:8000/api/room/${this.roomId}/users`);
      const userIds: string[] = res.data['userIds'];
      const users = await Promise.all(
        userIds.map(async (userId: string) => {
          const user = await this.userService.getUserInfo(userId);
          return user;
        })
      );
      this.users = users;
    } catch (error) {
      console.error('Failed to fetch users', error);
    }
  }

  initSocketListeners() {
    this.socketService.onAudioRoomMessage(async (msg: any) => {
      const { type, user_id, from, data } = msg;

      if (type === 'user-joined') {
        const newUser = await this.userService.getUserInfo(user_id.toString());
        if (!this.users.find(u => u.id === newUser.id)) {
          this.users.push(newUser);
        }

        // Only if we're connected (i.e. in voice), treat them as a voice participant
        if (this.connected && user_id !== this.userId) {
          this.voiceUserIds.add(user_id);

          const pc = this.createPeerConnection(user_id);
          this.peers.set(user_id, pc);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          this.sendMessage({ type: 'offer', target: user_id, data: offer });
        }
        return;
      }

      if (type === 'user-left') {
        this.voiceUserIds.delete(user_id);
        this.users = this.users.filter(u => u.id !== user_id);
        this.removeRemoteUser(user_id);
        return;
      }

      if (from === this.userId) return;

      let pc = this.peers.get(from);
      if (!pc) {
        pc = this.createPeerConnection(from);
        this.peers.set(from, pc);
      }

      switch (type) {
        case 'offer':
          await pc.setRemoteDescription(new RTCSessionDescription(data));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.sendMessage({ type: 'answer', target: from, data: answer });
          break;
        case 'answer':
          await pc.setRemoteDescription(new RTCSessionDescription(data));
          break;
        case 'candidate':
          await pc.addIceCandidate(new RTCIceCandidate(data));
          break;
      }
    });
  }

  async joinVoiceRoom() {
    if (this.connected) return;
    this.connected = true;
    this.voiceUserIds.add(this.userId);  // Add self to voice chat list

    try {
      this.audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.mergeStreams();

      for (const user of this.users) {
        if (user.id !== this.userId) {
          const pc = this.createPeerConnection(user.id);
          this.peers.set(user.id, pc);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          this.sendMessage({ type: 'offer', target: user.id, data: offer });
        }
      }
    } catch (err) {
      alert("Failed to access microphone.");
      this.connected = false;
      console.error(err);
    }
  }

  async toggleCamera() {
    if (!this.connected) return;
    this.isCameraEnabled = !this.isCameraEnabled;

    if (this.isCameraEnabled) {
      try {
        this.cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
      } catch (err) {
        alert("Failed to access camera.");
        this.isCameraEnabled = false;
        console.error(err);
      }
    } else if (this.cameraStream) {
      this.cameraStream.getTracks().forEach(t => t.stop());
      this.cameraStream = undefined!;
    }

    this.mergeStreams();
  }

  async toggleScreenShare() {
    if (!this.connected) return;
    this.isScreenSharing = !this.isScreenSharing;

    if (this.isScreenSharing) {
      try {
        this.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        this.screenStream.getVideoTracks()[0].onended = () => {
          this.isScreenSharing = false;
          this.screenStream = undefined!;
          this.mergeStreams();
        };
      } catch (err) {
        alert("Failed to start screen sharing.");
        this.isScreenSharing = false;
        console.error(err);
      }
    } else if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
      this.screenStream = undefined!;
    }

    this.mergeStreams();
  }

  toggleMic() {
    if (!this.connected) return;
    this.isMicEnabled = !this.isMicEnabled;
    if (this.audioStream) {
      this.audioStream.getAudioTracks().forEach(t => t.enabled = this.isMicEnabled);
    }
  }

  mergeStreams() {
    const merged = new MediaStream();

    [this.audioStream, this.cameraStream, this.screenStream].forEach(stream => {
      if (stream) {
        stream.getTracks().forEach(track => merged.addTrack(track));
      }
    });

    this.localStream = merged;

    if (this.localVideoRef?.nativeElement && this.cameraStream) {
      this.localVideoRef.nativeElement.srcObject = this.cameraStream;
    }

    this.replaceAllTracks();
  }

  replaceAllTracks() {
    for (const [userId, pc] of this.peers.entries()) {
      const senders = pc.getSenders();
      this.localStream.getTracks().forEach(track => {
        const sender = senders.find(s => s.track?.kind === track.kind);
        if (sender) {
          sender.replaceTrack(track);
        } else {
          pc.addTrack(track, this.localStream);
        }
      });
    }
  }

  createPeerConnection(remoteUserId: number): RTCPeerConnection {
    const pc = new RTCPeerConnection();

    this.localStream?.getTracks().forEach(track => {
      pc.addTrack(track, this.localStream);
    });

    const remoteVideoId = `remote-video-${remoteUserId}`;
    let remoteVideoEl = document.getElementById(remoteVideoId) as HTMLVideoElement;
    if (!remoteVideoEl) {
      remoteVideoEl = document.createElement('video');
      remoteVideoEl.id = remoteVideoId;
      remoteVideoEl.autoplay = true;
      remoteVideoEl.playsInline = true;
      document.body.appendChild(remoteVideoEl);
    }

    const remoteStream = new MediaStream();
    pc.ontrack = (event) => {
      event.streams[0].getTracks().forEach(track => remoteStream.addTrack(track));
      remoteVideoEl.srcObject = remoteStream;
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendMessage({ type: 'candidate', target: remoteUserId, data: event.candidate });
      }
    };

    return pc;
  }

  sendMessage(message: any) {
    this.socketService.sendMessage(JSON.stringify(message), false, 'audioRoom');
  }

  removeRemoteUser(userId: number) {
    const videoEl = document.getElementById(`remote-video-${userId}`);
    if (videoEl) videoEl.remove();
    const pc = this.peers.get(userId);
    pc?.close();
    this.peers.delete(userId);
  }

  leave() {
    this.sendMessage({ type: 'user-left', user_id: this.userId });
    this.socketService.disconnectAll();

    [this.audioStream, this.cameraStream, this.screenStream, this.localStream].forEach(stream => {
      stream?.getTracks().forEach(track => track.stop());
    });

    this.peers.forEach(pc => pc.close());
    this.peers.clear();

    this.voiceUserIds.clear();
    this.connected = false;
  }
}
