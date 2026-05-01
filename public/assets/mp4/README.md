# MP4 assets

Drop the following files into this folder before deployment:

* `music.mp4`    — fullscreen looping video for `mode_music`
* `cleaning.mp4` — fullscreen looping video for `mode_cleaning`

Both files are played silenced (browsers require muted videos for
autoplay), looped, with no controls. Recommended encoding:

* H.264 / AAC (or no audio) MP4 container
* 800x480 or higher (will be `object-fit: cover`'d)
* keep file size small so it fits on the Pi
