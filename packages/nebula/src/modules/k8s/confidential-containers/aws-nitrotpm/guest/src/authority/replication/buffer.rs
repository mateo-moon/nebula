use super::MAX_REPLICA_BYTES;
use std::{
    io,
    pin::Pin,
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncSeek, AsyncWrite, ReadBuf};
use zeroize::Zeroizing;

/// In-memory snapshot transport. Size is bounded while streaming, not only
/// after receipt, and plaintext snapshot bytes are zeroed when dropped.
#[derive(Default)]
pub struct SnapshotBuffer {
    pub(super) bytes: Zeroizing<Vec<u8>>,
    position: u64,
}
impl SnapshotBuffer {
    pub(super) fn new(bytes: Zeroizing<Vec<u8>>) -> Self {
        Self { bytes, position: 0 }
    }
}
impl AsyncRead for SnapshotBuffer {
    fn poll_read(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
        out: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let start = (self.position as usize).min(self.bytes.len());
        let count = out.remaining().min(self.bytes.len() - start);
        out.put_slice(&self.bytes[start..start + count]);
        self.position += count as u64;
        Poll::Ready(Ok(()))
    }
}
impl AsyncWrite for SnapshotBuffer {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        let start = self.position as usize;
        let Some(end) = start
            .checked_add(bytes.len())
            .filter(|end| *end <= MAX_REPLICA_BYTES)
        else {
            return Poll::Ready(Err(io::Error::other("snapshot capacity exceeded")));
        };
        if end > self.bytes.len() {
            self.bytes.resize(end, 0);
        }
        self.bytes[start..end].copy_from_slice(bytes);
        self.position = end as u64;
        Poll::Ready(Ok(bytes.len()))
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}
impl AsyncSeek for SnapshotBuffer {
    fn start_seek(mut self: Pin<&mut Self>, position: io::SeekFrom) -> io::Result<()> {
        let offset = match position {
            io::SeekFrom::Start(offset) => i128::from(offset),
            io::SeekFrom::End(offset) => self.bytes.len() as i128 + i128::from(offset),
            io::SeekFrom::Current(offset) => i128::from(self.position) + i128::from(offset),
        };
        if !(0..=MAX_REPLICA_BYTES as i128).contains(&offset) {
            return Err(io::Error::other("invalid snapshot offset"));
        }
        self.position = offset as u64;
        Ok(())
    }
    fn poll_complete(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<u64>> {
        Poll::Ready(Ok(self.position))
    }
}
