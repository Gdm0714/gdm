use super::action::{Action, modifier_keys, named_key, text_keys};
use crate::support::{Error, Result};
use des::{
    Des,
    cipher::{BlockEncrypt, KeyInit},
};
use std::{
    collections::BTreeSet,
    io::{Read, Write},
    thread,
    time::Duration,
};

#[derive(Clone)]
pub struct Frame {
    pub width: u16,
    pub height: u16,
    pub rgba: Vec<u8>,
}
impl Frame {
    pub fn png(&self) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, self.width as u32, self.height as u32);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder
                .write_header()
                .map_err(|e| Error::new("png", e.to_string()))?;
            writer
                .write_image_data(&self.rgba)
                .map_err(|e| Error::new("png", e.to_string()))?;
        }
        Ok(bytes)
    }
    pub fn fingerprint(&self) -> String {
        let mut b = self.width.to_be_bytes().to_vec();
        b.extend(self.height.to_be_bytes());
        b.extend(&self.rgba);
        crate::support::sha256(b)
    }
}
pub fn apple_password(password: &[u8]) -> Result<Vec<u8>> {
    if password.is_empty() || password.len() > 8 {
        return Err(Error::new("vnc", "password must be 1 to 8 bytes"));
    }
    let key = [
        0x17, 0x34, 0x51, 0x6e, 0x8b, 0xa8, 0xc5, 0xe2, 0xff, 0x1c, 0x39, 0x56, 0x73, 0x90, 0xad,
        0xca,
    ];
    let mut bytes = key;
    for (i, b) in password.iter().enumerate() {
        bytes[i] ^= b;
    }
    Ok(hex::encode_upper(bytes).into_bytes())
}
pub fn challenge_response(password: &[u8], challenge: &[u8]) -> Result<Vec<u8>> {
    if password.is_empty() || password.len() > 8 || challenge.len() != 16 {
        return Err(Error::new("vnc", "invalid VNC authentication input"));
    }
    let mut key = [0; 8];
    for (i, b) in password.iter().enumerate() {
        key[i] = b.reverse_bits();
    }
    let cipher = Des::new((&key).into());
    let mut response = challenge.to_vec();
    for block in response.chunks_exact_mut(8) {
        cipher.encrypt_block(block.into());
    }
    key.fill(0);
    Ok(response)
}
pub struct Rfb<R: Read, W: Write> {
    reader: R,
    writer: W,
    frame: Frame,
    held: BTreeSet<u32>,
    pointer: (u16, u16, u8),
}
impl<R: Read, W: Write> Rfb<R, W> {
    pub fn connect(reader: R, writer: W, password: &[u8]) -> Result<Self> {
        let mut s = Self {
            reader,
            writer,
            frame: Frame {
                width: 0,
                height: 0,
                rgba: Vec::new(),
            },
            held: BTreeSet::new(),
            pointer: (0, 0, 0),
        };
        let version = s.read(12)?;
        if version != b"RFB 003.008\n" && version != b"RFB 003.889\n" {
            return Err(Error::new("rfb", "unsupported server version"));
        }
        s.write(b"RFB 003.008\n")?;
        let n = s.read(1)?[0] as usize;
        if n == 0 {
            return Err(Error::new("rfb", "server rejected negotiation"));
        }
        if !s.read(n)?.contains(&2) {
            return Err(Error::new("rfb", "authenticated VNC security required"));
        }
        s.write(&[2])?;
        let c = s.read(16)?;
        s.write(&challenge_response(password, &c)?)?;
        if s.read(4)? != [0, 0, 0, 0] {
            return Err(Error::new("rfb", "authentication failed"));
        }
        s.write(&[1])?;
        let init = s.read(24)?;
        s.resize(u16be(&init, 0), u16be(&init, 2))?;
        let length = u32be(&init, 20) as usize;
        if length > 4096 {
            return Err(Error::new("rfb", "desktop name too long"));
        }
        s.read(length)?;
        s.write(&[
            0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0,
        ])?;
        let mut encoding = vec![2, 0, 0, 2, 0, 0, 0, 0];
        encoding.extend((-223i32).to_be_bytes());
        s.write(&encoding)?;
        Ok(s)
    }
    fn read(&mut self, n: usize) -> Result<Vec<u8>> {
        if n > 4096 * 2560 * 4 + 65536 {
            return Err(Error::new("rfb", "read exceeds bounds"));
        }
        let mut b = vec![0; n];
        self.reader.read_exact(&mut b)?;
        Ok(b)
    }
    fn write(&mut self, b: &[u8]) -> Result<()> {
        self.writer.write_all(b)?;
        self.writer.flush()?;
        Ok(())
    }
    fn resize(&mut self, w: u16, h: u16) -> Result<()> {
        if w == 0 || h == 0 || w > 4096 || h > 2560 {
            return Err(Error::new("rfb", "invalid framebuffer size"));
        }
        self.frame = Frame {
            width: w,
            height: h,
            rgba: vec![0; w as usize * h as usize * 4],
        };
        Ok(())
    }
    fn point(&self, x: u16, y: u16) -> Result<()> {
        if x >= self.frame.width || y >= self.frame.height {
            return Err(Error::new("usage", "point outside framebuffer"));
        }
        Ok(())
    }
    fn pointer(&mut self, x: u16, y: u16, mask: u8) -> Result<()> {
        self.point(x, y)?;
        let mut b = vec![5, mask];
        b.extend(x.to_be_bytes());
        b.extend(y.to_be_bytes());
        if mask != 0 {
            self.pointer = (x, y, mask);
        }
        self.write(&b)?;
        self.pointer = (x, y, mask);
        Ok(())
    }
    fn key(&mut self, key: u32, down: bool) -> Result<()> {
        let mut b = vec![4, u8::from(down), 0, 0];
        b.extend(key.to_be_bytes());
        if down {
            self.held.insert(key);
        }
        self.write(&b)?;
        if !down {
            self.held.remove(&key);
        }
        Ok(())
    }
    pub fn release_all(&mut self) {
        for k in self.held.clone() {
            let _ = self.key(k, false);
        }
        let (x, y, m) = self.pointer;
        if m != 0 {
            let _ = self.pointer(x, y, 0);
        }
    }
    pub fn screenshot(&mut self) -> Result<Frame> {
        for _ in 0..3 {
            let mut request = vec![3, 0, 0, 0, 0, 0];
            request.extend(self.frame.width.to_be_bytes());
            request.extend(self.frame.height.to_be_bytes());
            self.write(&request)?;
            for _ in 0..16 {
                match self.read(1)?[0] {
                    0 => {
                        if self.update()? {
                            return Ok(self.frame.clone());
                        }
                        break;
                    }
                    2 => {}
                    3 => {
                        let h = self.read(7)?;
                        let n = u32be(&h, 3) as usize;
                        if n > 32768 {
                            return Err(Error::new("rfb", "clipboard exceeds limit"));
                        }
                        self.read(n)?;
                    }
                    _ => return Err(Error::new("rfb", "unsupported server message")),
                }
            }
        }
        Err(Error::new(
            "rfb",
            "server did not return framebuffer pixels",
        ))
    }
    fn update(&mut self) -> Result<bool> {
        let header = self.read(3)?;
        let count = u16be(&header, 1);
        if count > 64 {
            return Err(Error::new("rfb", "too many rectangles"));
        }
        let mut updated = false;
        for _ in 0..count {
            let r = self.read(12)?;
            let (x, y, w, h) = (u16be(&r, 0), u16be(&r, 2), u16be(&r, 4), u16be(&r, 6));
            let encoding = i32::from_be_bytes(
                r[8..12]
                    .try_into()
                    .map_err(|_| Error::new("rfb", "encoding"))?,
            );
            if encoding == -223 {
                if x != 0 || y != 0 {
                    return Err(Error::new("rfb", "nonzero resize origin"));
                }
                self.resize(w, h)?;
                continue;
            }
            if encoding != 0 {
                return Err(Error::new("rfb", "unsupported pixel encoding"));
            }
            if w == 0
                || h == 0
                || x as u32 + w as u32 > self.frame.width as u32
                || y as u32 + h as u32 > self.frame.height as u32
            {
                return Err(Error::new("rfb", "rectangle outside framebuffer"));
            }
            let pixels = self.read(w as usize * h as usize * 4)?;
            for row in 0..h as usize {
                for col in 0..w as usize {
                    let a = (row * w as usize + col) * 4;
                    let b = ((y as usize + row) * self.frame.width as usize + x as usize + col) * 4;
                    self.frame.rgba[b..b + 4].copy_from_slice(&[
                        pixels[a + 2],
                        pixels[a + 1],
                        pixels[a],
                        255,
                    ]);
                }
            }
            updated = true;
        }
        Ok(updated)
    }
    pub fn action(&mut self, action: &Action) -> Result<()> {
        action.validate()?;
        let result = (|| -> Result<()> {
            match action {
                Action::Click {
                    x,
                    y,
                    button,
                    click_count,
                } => {
                    self.point(*x, *y)?;
                    for i in 0..*click_count {
                        check_cancelled()?;
                        self.pointer(*x, *y, button.mask())?;
                        pause(50);
                        self.pointer(*x, *y, 0)?;
                        if i + 1 < *click_count {
                            pause(100);
                        }
                    }
                }
                Action::TypeText { text } => {
                    for k in text_keys(text)? {
                        check_cancelled()?;
                        self.key(k, true)?;
                        pause(4);
                        self.key(k, false)?;
                        pause(4);
                    }
                }
                Action::PressKey { key, modifiers } => {
                    let keys = modifier_keys(modifiers)?;
                    let key = named_key(key)?;
                    let result: Result<()> = (|| {
                        for k in &keys {
                            self.key(*k, true)?;
                        }
                        pause(20);
                        self.key(key, true)?;
                        pause(20);
                        self.key(key, false)?;
                        pause(20);
                        Ok(())
                    })();
                    let mut release_error = None;
                    for k in keys.iter().rev() {
                        if let Err(e) = self.key(*k, false) {
                            release_error.get_or_insert(e);
                        }
                    }
                    result?;
                    if let Some(e) = release_error {
                        return Err(e);
                    }
                }
                Action::Scroll { x, y, dx, dy } => {
                    self.point(*x, *y)?;
                    self.pointer(*x, *y, 0)?;
                    for (v, negative, positive) in [(*dy, 16, 8), (*dx, 32, 64)] {
                        for _ in 0..v.unsigned_abs() {
                            check_cancelled()?;
                            self.pointer(*x, *y, if v < 0 { negative } else { positive })?;
                            self.pointer(*x, *y, 0)?;
                        }
                    }
                }
                Action::Drag {
                    x,
                    y,
                    to_x,
                    to_y,
                    button,
                } => {
                    self.point(*x, *y)?;
                    self.point(*to_x, *to_y)?;
                    let steps = (x.abs_diff(*to_x).max(y.abs_diff(*to_y)) as u32)
                        .div_ceil(20)
                        .max(1);
                    self.pointer(*x, *y, button.mask())?;
                    let result: Result<()> = (|| {
                        for step in 1..=steps {
                            check_cancelled()?;
                            let nx = (*x as f64
                                + (*to_x as f64 - *x as f64) * step as f64 / steps as f64)
                                .round() as u16;
                            let ny = (*y as f64
                                + (*to_y as f64 - *y as f64) * step as f64 / steps as f64)
                                .round() as u16;
                            pause(15);
                            self.pointer(nx, ny, button.mask())?;
                        }
                        Ok(())
                    })();
                    let released = self.pointer(*to_x, *to_y, 0);
                    result?;
                    released?;
                }
                _ => return Err(Error::new("usage", "action not handled by RFB")),
            }
            Ok(())
        })();
        if result.is_err() {
            self.release_all();
        }
        result
    }
}
fn check_cancelled() -> Result<()> {
    if super::cancelled() {
        Err(Error::new("cancelled", "guest input cancelled"))
    } else {
        Ok(())
    }
}
fn pause(ms: u64) {
    thread::sleep(Duration::from_millis(ms));
}
fn u16be(b: &[u8], i: usize) -> u16 {
    u16::from_be_bytes([b[i], b[i + 1]])
}
fn u32be(b: &[u8], i: usize) -> u32 {
    u32::from_be_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn computer_use_apple_password_vector() {
        assert_eq!(
            String::from_utf8(apple_password(b"gdmsetup").unwrap()).unwrap(),
            "70503C1DEE DC B092FF1C39567390ADCA".replace(' ', "")
        );
    }
    #[test]
    fn computer_use_refuses_unauthenticated_rfb() {
        let mut bytes = b"RFB 003.008\n".to_vec();
        bytes.extend([1, 1]);
        assert!(Rfb::connect(std::io::Cursor::new(bytes), Vec::new(), b"password").is_err());
    }
}
