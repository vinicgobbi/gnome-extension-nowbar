UUID := nowbar@vinicgobbi.dev.br
SRC := $(UUID)
DEST := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: schemas styles install uninstall pack sync-model test nested

schemas:
	glib-compile-schemas $(SRC)/schemas

# stylesheet-light.css (light shell) is made from stylesheet.css.
styles:
	tools/gen-light-css.sh

# Copies the extension where GNOME Shell looks for it. Log out and back in
# (Wayland) or restart the shell (X11), then: gnome-extensions enable $(UUID)
install: schemas styles
	rm -rf $(DEST)
	mkdir -p $(DEST)
	cp -r $(SRC)/. $(DEST)/

uninstall:
	rm -rf $(DEST)

# The zip for extensions.gnome.org.
# (gnome-extensions crashes when the out dir doesn't exist yet.)
pack: styles
	mkdir -p dist
	gnome-extensions pack $(SRC) --force --out-dir=$(CURDIR)/dist --extra-source=lib

sync-model:
	tools/sync-model.sh

test:
	gjs -m tests/model.test.js

# A shell in a window, to try it without logging out. It gets its own
# settings, state and extensions folder (set before the bus starts, so the
# bus-activated dconf uses them too): nothing it does reaches your session.
NESTED := $(CURDIR)/.nested
nested: schemas
	rm -rf $(NESTED) && mkdir -p $(NESTED)/data/gnome-shell/extensions $(NESTED)/config
	cp -r $(SRC) $(NESTED)/data/gnome-shell/extensions/
	env XDG_DATA_HOME=$(NESTED)/data XDG_CONFIG_HOME=$(NESTED)/config \
		XDG_STATE_HOME=$(NESTED)/state XDG_CACHE_HOME=$(NESTED)/cache \
		dbus-run-session -- sh -c 'gsettings set org.gnome.shell enabled-extensions "[\x27$(UUID)\x27]" && gnome-shell --devkit --wayland'
