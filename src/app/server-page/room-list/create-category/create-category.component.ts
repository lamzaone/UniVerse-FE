import { CommonModule } from '@angular/common';
import { Component, Output } from '@angular/core';
import { FormsModule, NgModel } from '@angular/forms';
import { EventEmitter } from '@angular/core';
import { ServersService } from '../../../services/servers.service';

@Component({
  selector: 'app-create-category',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './create-category.component.html',
  styleUrl: './create-category.component.scss'
})
export class CreateCategoryComponent {
  constructor(
    private serversService:ServersService
  ){

  }
  categoryName:string =""
  categoryDescription:string = ""
  categoryType:string = "Normal"

  // signal to emit closed
  @Output() close = new EventEmitter<void>();

  close_page(){
    this.close.emit();
  }

  createCategory(){
    console.log(this.categoryName, this.categoryDescription);
    this.serversService.createCategory(this.serversService.currentServer().id, this.categoryName, this.categoryType, this.categoryDescription);
    this.close_page();
  }
}
