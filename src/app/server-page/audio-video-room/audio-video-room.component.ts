import {
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

  roomId: number = 14; // TODO: replace with route param
  userId = this.authService.getUser().id;

  users: any[] = [];
  voiceUserIds: Set<number> = new Set();

  audioStream?: MediaStream;
  cameraStream?: MediaStream;
  screenStream?: MediaStream;

  isInCall = false;
  isScreenSharing = false;
  isCameraEnabled = false;
  isMicMuted = false;

  constructor(
    private userService: UsersService,
    private authService: AuthService,
    private socketService: SocketService
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
    this.users = [];
    try {
      const res = await api.get(`http://lamzaone.go.ro:8000/api/room/${this.roomId}/users`);
      const userIds: string[] = res.data['userIds'];
      const users = await Promise.all(
        userIds.map(async (userId: string) => {
          const user = await this.userService.getUserInfo(userId);
          this.voiceUserIds.add(parseInt(user.id));
          return user;
        })
      );
      this.users = users;
    } catch (error) {
      console.error('Failed to fetch users', error);
    }
  }

  setupSocketListeners() {
    this.socketService.onAudioRoomMessage((message: string) => {
      console.log('Socket message:', message);
      if (['user_joined_call', 'user_left_call'].includes(message.split(':')[0])) {
        const userId = parseInt(message.split(':&')[1]);
        this.voiceUserIds.add(parseInt(message.split(':&')[1]));
        if (message.startsWith('user_joined_call')) {
          // add user to voiceUserIds
          this.voiceUserIds.add(userId);
        } else {
          // remove user from voiceUserIds
          this.voiceUserIds.delete(userId);
        }
        this.fetchInitialUsers();
      } else if (message === 'room_closed') {
        this.leaveCall();
      }
    });
  }

  async joinVoiceRoom() {
    if (this.isInCall) return;

    try {
      this.audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.isMicMuted = false;

      this.setVideoStream(this.audioStream);

      this.socketService.sendMessage("user_joined_call:&"+this.userId, false, 'audioRoom');
      this.isInCall = true;
      this.voiceUserIds.add(this.userId);
    } catch (error) {
      console.error('Error joining call:', error);
    }
  }

  async toggleCamera() {
    if (!this.isInCall) return;

    this.isCameraEnabled = !this.isCameraEnabled;

    if (this.isCameraEnabled) {
      try {
        this.cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
        this.setVideoStream(this.cameraStream);
      } catch (error) {
        console.error('Error accessing camera:', error);
        this.isCameraEnabled = false;
      }
    } else {
      this.stopStream(this.cameraStream);
      this.cameraStream = undefined;
      this.setVideoStream(this.audioStream);
    }
  }

  async toggleScreenShare() {
    if (!this.isInCall) return;

    this.isScreenSharing = !this.isScreenSharing;

    if (this.isScreenSharing) {
      try {
        this.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        this.setVideoStream(this.screenStream);

        this.screenStream.getVideoTracks()[0].onended = () => {
          this.isScreenSharing = false;
          this.screenStream = undefined;
          this.setVideoStream(this.cameraStream || this.audioStream);
        };
      } catch (error) {
        console.error('Error starting screen share:', error);
        this.isScreenSharing = false;
      }
    } else {
      this.stopStream(this.screenStream);
      this.screenStream = undefined;
      this.setVideoStream(this.cameraStream || this.audioStream);
    }
  }

  toggleMic() {
    if (!this.isInCall || !this.audioStream) return;
    this.isMicMuted = !this.isMicMuted;
    this.audioStream.getAudioTracks().forEach(track => {
      track.enabled = !this.isMicMuted;
    });
  }

  leaveCall() {
    if (!this.isInCall) return;

    [this.audioStream, this.cameraStream, this.screenStream].forEach(stream => {
      this.stopStream(stream);
    });

    this.audioStream = undefined;
    this.cameraStream = undefined;
    this.screenStream = undefined;

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

  private setVideoStream(stream?: MediaStream) {
    if (this.localVideoRef?.nativeElement && stream) {
      this.localVideoRef.nativeElement.srcObject = stream;
    }
  }

  private stopStream(stream?: MediaStream) {
    stream?.getTracks().forEach(track => track.stop());
  }
}
