BR.RoutingOptions = L.Evented.extend({
    options: {
        shortcut: {
            switch: 71, // char code for 'g'
        },
    },

    initialize() {
        $('#profile-alternative, #route-alternative').on('changed.bs.select', this._getChangeHandler());

        var remembered_profile = this.getRememberedProfile();
        var remembered_profile_was_selected = false;

        // build option list from config
        var profiles = BR.conf.profiles;
        var profiles_list = L.DomUtil.get('profile');
        for (var i = 0; i < profiles.length; i++) {
            var option = document.createElement('option');
            option.value = profiles[i];
            option.dataset.builtin = 'true';
            option.text = i18next.t('navbar.profile.' + profiles[i]);
            // set remembered profile, only when no URL hash (assumes fullHash plugin not initialised yet)
            if (!location.hash && remembered_profile !== null && remembered_profile === profiles[i]) {
                option.selected = true;
                remembered_profile_was_selected = true;
            }
            profiles_list.appendChild(option);
        }
        // set default value, used as indicator for empty custom profile
        profiles_list.children[0].value = 'Custom';
        profiles_list.children[0].id = 'custom-routing-profile';
        if (!remembered_profile_was_selected) {
            // <custom> profile is empty at start, select next one
            profiles_list.children[1].selected = true;
        }

        L.DomEvent.addListener(document, 'keydown', this._keydownListener, this);
    },

    refreshUI() {
        // disable custom option if it has no value yet (default value is "Custom")
        var custom = L.DomUtil.get('custom-routing-profile');
        if (custom.value === 'Custom') {
            custom.disabled = true;
        }
        $('#profile option[data-profile-heading]').prop('disabled', true);
        $('#profile-alternative, #route-alternative').selectpicker('refresh');

        [
            ['#profile-alternative', 'G'],
            ['#route-alternative', 'Shift+G'],
        ].forEach(([selector, key]) => {
            const picker = $(selector).data('selectpicker');
            if (picker) {
                // Return keyboard focus to the map after closing or confirming,
                // so letter shortcuts do not reopen the focused toggle.
                if (!picker.routingEscapeBound) {
                    picker.$newElement[0].addEventListener(
                        'keydown',
                        (event) => {
                            if (event.keyCode === 27) this._keydownListener(event);
                            if (event.keyCode === 13 && picker.$newElement.hasClass('show')) {
                                // Wait for the entire event dispatch, including the
                                // plugin's delegated handler on document, to finish.
                                setTimeout(() => this._exitSelection(picker), 0);
                            }
                        },
                        true
                    );
                    picker.routingEscapeBound = true;
                }
                const text = $(selector).find('option:selected').text();
                picker.$button.attr('title', text + i18next.t('navbar.profile-tooltip', { key }));
            }
        });
    },

    getOptions() {
        var profile = $('#profile option:selected'),
            alternative = $('#alternative option:selected');
        this.refreshUI();

        const selected = profile[0];
        const profileValue =
            selected && selected.dataset.savedId
                ? selected.dataset.serverProfile || this.getCustomProfile() || BR.conf.profiles[0]
                : profile.val();
        return {
            profile: profileValue,
            alternative: alternative.val(),
        };
    },

    setOptions(options) {
        // Update both controls together without routing with a partial selection.
        this.settingOptions = true;
        try {
            if (options.profile != null) $('#profile-alternative').selectpicker('val', options.profile);
            if (options.alternative != null) $('#route-alternative').selectpicker('val', String(options.alternative));
        } finally {
            this.settingOptions = false;
        }
        this.refreshUI();

        if (options.profile && L.BRouter.isCustomProfile(options.profile)) {
            // custom profile passed with permalink
            this.setCustomProfile(options.profile, true);
        }
    },

    setSavedProfiles(profiles, activeId) {
        const group = L.DomUtil.get('profile');
        const selected = group.querySelector('option:checked');
        const previousValue = selected && selected.value;
        const serverProfiles = {};
        group
            .querySelectorAll('option[data-profile-heading], option[data-divider]')
            .forEach((option) => option.remove());
        group.querySelectorAll('option[data-saved-id]').forEach((option) => {
            serverProfiles[option.dataset.savedId] = option.dataset.serverProfile;
            option.remove();
        });
        profiles.forEach((item) => {
            const option = document.createElement('option');
            option.value = 'saved-profile:' + item.id;
            option.dataset.savedId = item.id;
            if (serverProfiles[item.id]) option.dataset.serverProfile = serverProfiles[item.id];
            option.textContent = item.name;
            group.insertBefore(option, group.querySelector('option[data-builtin]'));
        });
        const heading = (key) => {
            const option = document.createElement('option');
            option.dataset.profileHeading = 'true';
            option.value = 'heading:' + key;
            const label = document.createElement('small');
            label.className = 'text-muted';
            label.textContent = i18next.t('navbar.' + key);
            option.textContent = label.textContent;
            option.dataset.content = label.outerHTML;
            option.disabled = true;
            return option;
        };
        group.insertBefore(heading('custom-profiles'), group.firstChild);
        const builtin = group.querySelector('option[data-builtin]');
        const divider = document.createElement('option');
        divider.dataset.divider = 'true';
        group.insertBefore(divider, builtin);
        group.insertBefore(heading('builtin-profiles'), builtin);
        const value = activeId ? 'saved-profile:' + activeId : previousValue;
        const target = Array.from(group.children).find((option) => option.value === value);
        if (target) {
            Array.from(group.children).forEach((option) => {
                option.selected = option === target;
            });
        } else if (!group.querySelector('option:checked')) {
            group.querySelector('option[data-builtin]').selected = true;
        }
        this.refreshUI();
    },

    restoreSelection(values) {
        const selectedValues = Array.isArray(values) ? values : [values];
        Array.from(L.DomUtil.get('profile-alternative').options).forEach((option) => {
            option.selected = selectedValues.indexOf(option.value) !== -1;
        });
        this.refreshUI();
    },

    setCustomProfile(profile, noUpdate, savedId) {
        var profiles_grp, option;

        profiles_grp = L.DomUtil.get('profile');
        option = L.DomUtil.get('custom-routing-profile');
        option.value = profile || 'Custom';
        option.disabled = !profile;

        if (profile) {
            $('#profile')
                .find('option:selected')
                .each(function (index) {
                    $(this).prop('selected', false);
                });
        } else if (option.selected) {
            // clear, select next in group when custom deselected
            profiles_grp.querySelector('option[data-builtin]').selected = true;
        }

        option.selected = !!profile;
        if (profile && savedId) {
            const saved = Array.from(profiles_grp.children).find((item) => item.dataset.savedId === savedId);
            if (saved) {
                option.selected = false;
                saved.dataset.serverProfile = profile;
                saved.selected = true;
            }
        }

        if (!noUpdate) {
            this.fire('update', { options: this.getOptions() });
        }
    },

    resetToDefault() {
        this.setCustomProfile(null, true);
        L.DomUtil.get('profile-alternative').value = BR.conf.profiles[0];
        L.DomUtil.get('route-alternative').value = '0';
        this.rememberProfile(BR.conf.profiles[0]);
        this.fire('update', { options: this.getOptions() });
    },

    getCustomProfile() {
        var option = L.DomUtil.get('custom-routing-profile'),
            profile = null;

        if (option.value !== 'Custom') {
            profile = option.value;
        }
        return profile;
    },

    rememberProfile(profile) {
        if (!BR.Util.localStorageAvailable()) {
            return;
        }

        if (L.BRouter.isCustomProfile(profile)) {
            if (localStorage.getItem('routingprofile.customText')) {
                localStorage.setItem('routingprofile', 'Custom');
            }
            return;
        }

        localStorage.setItem('routingprofile', profile);
    },

    getRememberedProfile() {
        if (!BR.Util.localStorageAvailable()) {
            return null;
        }

        return localStorage.getItem('routingprofile');
    },

    _getChangeHandler() {
        return L.bind(function (evt, clickedIndex, isSelected, previousValue) {
            if (this.settingOptions) return;
            // bootstrap-select also emits changes for programmatic startup/hash
            // updates, with no clicked index. Only persist an actual user choice.
            if (clickedIndex != null) {
                const option = evt.target.options[clickedIndex];
                if (option.dataset.savedId) {
                    this.fire('saved-profile', { id: option.dataset.savedId, previousValue });
                    return;
                }
                if (option.parentElement.id === 'profile') {
                    this.rememberProfile(option.value);
                }
            }
            this.fire('update', {
                options: this.getOptions(),
                alternativeOnly: evt.target.id === 'route-alternative',
            });
        }, this);
    },

    _exitSelection(picker) {
        picker.$button.dropdown('hide');
        const map = L.DomUtil.get('map');
        if (!map.hasAttribute('tabindex')) map.setAttribute('tabindex', '-1');
        map.focus();
    },

    _keydownListener(e) {
        // Escape must work while the normal app shortcuts are blocked by a menu.
        if (e.keyCode === 27) {
            const picker = $('#profile-alternative, #route-alternative')
                .map(function () {
                    return $(this).data('selectpicker');
                })
                .get()
                .find(
                    (item) =>
                        item &&
                        (item.$newElement.hasClass('show') || item.$newElement[0].contains(document.activeElement))
                );
            if (picker) {
                e.preventDefault();
                e.stopImmediatePropagation();
                this._exitSelection(picker);
                return;
            }
        }
        if (BR.Util.keyboardShortcutsAllowed(e) && e.keyCode === this.options.shortcut.switch) {
            const selector = e.shiftKey ? '#route-alternative' : '#profile-alternative';
            const picker = $(selector).data('selectpicker');
            if (picker && !picker.$newElement.hasClass('show')) {
                e.preventDefault();
                picker.toggle(e);
            }
        }
    },
});
