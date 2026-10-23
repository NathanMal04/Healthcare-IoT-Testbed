# Author: Paul: https://github.com/PaulleDemon
# Made using PyUibuilder: https://pyuibuilder.com
# MIT License - keep the copy of this license

# By default Label grows to fit the image, which isn't ideal for many use cases (image should grow to fit/cover the image instead)

import tkinter as tk
from PIL import Image, ImageTk


class ImageLabel(tk.Label):
    def __init__(self, master, image_path=None, mode="cover", width=100, height=100, *args, **kwargs):
        """
        mode:
        - "fit" -> Keeps aspect ratio, fits inside label
        - "cover" -> Covers label fully, cropping excess
        """
        super().__init__(master, width=width, height=height, *args, **kwargs) 
        self.parent = master
        self.image_path = image_path
        self.mode = mode
        self.original_image = None
        self.photo = None
        self.resize_job = None  # Debounce job reference

        if mode not in ['fit', 'cover']:
            raise Exception("Mode can only be fit or cover.")

        if image_path:
            try:
                self.original_image = Image.open(image_path)
                self.photo = ImageTk.PhotoImage(self.original_image)
                self.config(image=self.photo)

                self.force_resize() 
            except Exception as e:
                print(f"Error loading image: {e}")

        self.after(100, self.init_events)

    def init_events(self):
        self.parent.bind("<Configure>", self.on_resize)

    def on_resize(self, event=None):
        """Debounce resizing to prevent rapid execution."""
        if self.resize_job:
            self.after_cancel(self.resize_job)
        self.resize_job = self.after(1, self.force_resize)  # Debounce

    def force_resize(self):
        """Resize image using actual widget size."""

        if self.original_image is None:
            return  # Do nothing if no image is loaded

        width = self.winfo_width()  
        height = self.winfo_height()  

        if width < 5 or height < 5:
            return

        aspect_ratio = self.original_image.width / self.original_image.height

        if self.mode == "fit":
            if width / height > aspect_ratio:
                new_width = int(height * aspect_ratio)
                new_height = height
            else:
                new_width = width
                new_height = int(width / aspect_ratio)
            resized = self.original_image.resize((new_width, new_height), Image.LANCZOS)

        elif self.mode == "cover":
            if width / height > aspect_ratio:
                new_width = width
                new_height = int(width / aspect_ratio)
            else:
                new_width = int(height * aspect_ratio)
                new_height = height

            resized = self.original_image.resize((new_width, new_height), Image.LANCZOS)

            # Crop excess
            left = (new_width - width) // 2
            top = (new_height - height) // 2
            right = left + width
            bottom = top + height
            resized = resized.crop((left, top, right, bottom))

        # Update image
        self.photo = ImageTk.PhotoImage(resized)
        self.config(image=self.photo)