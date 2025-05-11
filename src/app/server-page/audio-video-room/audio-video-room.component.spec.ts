import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AudioVideoRoomComponent } from './audio-video-room.component';

describe('AudioVideoRoomComponent', () => {
  let component: AudioVideoRoomComponent;
  let fixture: ComponentFixture<AudioVideoRoomComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AudioVideoRoomComponent]
    })
    .compileComponents();
    
    fixture = TestBed.createComponent(AudioVideoRoomComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
