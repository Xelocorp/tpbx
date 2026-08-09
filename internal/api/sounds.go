package api

import (
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

// Sound is one uploaded IVR prompt file living under the server's sounds dir.
type Sound struct {
	Name     string `json:"name"`     // bare name, no extension (e.g. "welcome")
	Ref      string `json:"ref"`      // how the dialplan references it (e.g. "tpbx/welcome")
	File     string `json:"file"`     // on-disk filename (e.g. "welcome.wav")
	Size     int64  `json:"size"`     // bytes
	Modified string `json:"modified"` // RFC3339
}

// maxSoundBytes caps an uploaded prompt (generous for a WAV greeting).
const maxSoundBytes = 12 << 20 // 12 MiB

// soundName keeps only characters that are safe both on disk and in an Asterisk
// sound reference, and strips any extension/path. Returns "" if nothing usable
// remains (which the caller treats as a bad request).
func soundName(raw string) string {
	raw = strings.TrimSpace(raw)
	raw = filepath.Base(raw)                         // defeat path traversal
	raw = strings.TrimSuffix(raw, filepath.Ext(raw)) // drop .wav etc.
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '_' || r == '-':
			return r
		default:
			return -1
		}
	}, raw)
}

// soundsDirReady returns the configured sounds dir, creating it if needed. It
// returns "" (and writes a 503) when no sounds dir is configured.
func (s *Server) soundsDirReady(w http.ResponseWriter) (string, bool) {
	if s.SoundsDir == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "sound uploads are not configured on this server"})
		return "", false
	}
	if err := os.MkdirAll(s.SoundsDir, 0o775); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "cannot create sounds directory: " + err.Error()})
		return "", false
	}
	return s.SoundsDir, true
}

func (s *Server) soundRef(name string) string {
	if s.SoundsPrefix == "" {
		return name
	}
	return s.SoundsPrefix + "/" + name
}

func (s *Server) handleListSounds(w http.ResponseWriter, _ *http.Request) {
	out := []Sound{}
	if s.SoundsDir != "" {
		entries, _ := os.ReadDir(s.SoundsDir)
		for _, e := range entries {
			if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ".wav") {
				continue
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			name := strings.TrimSuffix(e.Name(), filepath.Ext(e.Name()))
			out = append(out, Sound{
				Name:     name,
				Ref:      s.soundRef(name),
				File:     e.Name(),
				Size:     info.Size(),
				Modified: info.ModTime().UTC().Format(time.RFC3339),
			})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	writeJSON(w, http.StatusOK, map[string]any{"sounds": out, "prefix": s.SoundsPrefix, "configured": s.SoundsDir != ""})
}

func (s *Server) handleUploadSound(w http.ResponseWriter, r *http.Request) {
	dir, ok := s.soundsDirReady(w)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxSoundBytes+4096)
	if err := r.ParseMultipartForm(maxSoundBytes + 4096); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "file too large or not a multipart upload"})
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "no file provided (field 'file')"})
		return
	}
	defer file.Close()

	// Name comes from the form field if given, else the uploaded filename.
	name := soundName(r.FormValue("name"))
	if name == "" {
		name = soundName(hdr.Filename)
	}
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid sound name (use letters, digits, - and _)"})
		return
	}

	// Sniff the header to confirm it is a RIFF/WAVE file before storing it.
	head := make([]byte, 12)
	n, _ := io.ReadFull(file, head)
	if n < 12 || string(head[0:4]) != "RIFF" || string(head[8:12]) != "WAVE" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "not a WAV file — upload PCM WAV (8kHz/16-bit mono recommended)"})
		return
	}

	dst := filepath.Join(dir, name+".wav")
	out, err := os.Create(dst)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "cannot write file: " + err.Error()})
		return
	}
	defer out.Close()
	if _, err := out.Write(head[:n]); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if _, err := io.Copy(out, file); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"status": "uploaded", "name": name, "ref": s.soundRef(name)})
}

// handleSoundAudio streams a stored prompt back for in-browser preview.
func (s *Server) handleSoundAudio(w http.ResponseWriter, r *http.Request) {
	if s.SoundsDir == "" {
		http.NotFound(w, r)
		return
	}
	name := soundName(chi.URLParam(r, "name"))
	if name == "" {
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(s.SoundsDir, name+".wav")
	f, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "audio/wav")
	http.ServeContent(w, r, name+".wav", info.ModTime(), f)
}

func (s *Server) handleDeleteSound(w http.ResponseWriter, r *http.Request) {
	if s.SoundsDir == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "sound uploads are not configured"})
		return
	}
	name := soundName(chi.URLParam(r, "name"))
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid name"})
		return
	}
	err := os.Remove(filepath.Join(s.SoundsDir, name+".wav"))
	if errors.Is(err, os.ErrNotExist) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}
