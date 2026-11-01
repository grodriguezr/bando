package com.demo.owner;

import static com.demo.owner.Formats.titulo;

import com.demo.model.*;

public class OwnerService {
    private final OwnerRepository repo;

    public OwnerService(OwnerRepository repo) {
        this.repo = repo;
    }

    public Owner register(String name) {
        var owner = new Owner();
        owner.addPet("Toby", 3);
        for (Pet pet : owner.getPets()) {
            pet.label();
        }
        repo.save(owner);
        owner.getId();
        owner.getPets().forEach(Pet::label);
        titulo(name);
        Formats.titulo(owner.getName());
        return this.repo.findById(1).orElseThrow();
    }

    private void helper() {
        register("x");
    }

    enum Estado {
        ACTIVO;

        String etiqueta() {
            return name();
        }
    }
}
