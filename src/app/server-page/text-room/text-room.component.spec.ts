import { ComponentFixture, TestBed } from '@angular/core/testing';

import { TextRoomComponent } from './text-room.component';

describe('TextRoomComponent', () => {
  let component: TextRoomComponent;
  let fixture: ComponentFixture<TextRoomComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TextRoomComponent]
    })
    .compileComponents();
    
    fixture = TestBed.createComponent(TextRoomComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
